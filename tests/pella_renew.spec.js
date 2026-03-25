// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000;

// ── 针对 tpi.li / cuttlinks 的强力注入脚本 ────────────────
const POWER_BYPASS_JS = `
(function() {
    'use strict';
    // 1. 屏蔽弹窗
    window.open = function() { return null; };
    // 2. 移除阻碍点击的透明层
    setInterval(() => {
        document.querySelectorAll('div[style*="z-index: 2147483647"], .popunder, #popads_container').forEach(el => el.remove());
        // 强制激活所有按钮
        ['#continue', '#getnewlink', 'a.get-link', '.btn-success'].forEach(s => {
            const btn = document.querySelector(s);
            if (btn) {
                btn.classList.remove('disabled');
                btn.style.display = 'block';
                btn.style.pointerEvents = 'auto';
            }
        });
    }, 1000);
})();
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: `🎮 Pella 续期: ${result}` });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, () => resolve());
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

test('Pella 自动续期', async () => {
    test.setTimeout(TIMEOUT);
    const proxyConfig = process.env.GOST_PROXY ? { server: 'http://127.0.0.1:8080' } : undefined;

    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    
    await context.addInitScript(POWER_BYPASS_JS);
    const page = await context.newPage();

    try {
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.keyboard.press('Enter');
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.keyboard.press('Enter');
        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
        console.log('✅ 登录成功');

        await sleep(3000);
        const token = await page.evaluate('window.Clerk.session.getToken()');
        const res = await page.evaluate(async (t) => {
            const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
            return r.json();
        }, token);

        // 挑选链接：不再屏蔽 tpi.li
        let renewLink = null;
        for (const s of (res.servers || [])) {
            const link = (s.renew_links || []).find(l => !l.claimed);
            if (link) { renewLink = link.link; break; }
        }

        if (!renewLink) {
            console.log('⚠️ 今日无需续期');
            return;
        }

        console.log(`🌐 访问续期链接: ${renewLink}`);

        // 监听目标 URL
        let capturedUrl = null;
        page.on('request', req => {
            if (req.url().includes('pella.app/renew/')) capturedUrl = req.url();
        });

        await page.goto(renewLink, { waitUntil: 'domcontentloaded' });

        // 🏹 针对 tpi.li 的 Cloudflare 穿透
        console.log('🛡️ 等待验证加载...');
        await sleep(8000); 
        const cfFrame = await page.$('iframe[src*="turnstile"]');
        if (cfFrame) {
            console.log('👆 发现 CF 验证，尝试点击...');
            await cfFrame.click().catch(() => {});
            await sleep(5000);
        }

        // 🏹 暴力跳转逻辑
        for (let i = 0; i < 40; i++) {
            if (capturedUrl || page.url().includes('pella.app/renew/')) break;

            await page.evaluate(() => {
                // 1. 尝试直接执行跳转函数 (tpi.li 常用逻辑)
                if (typeof window.get_link === 'function') { window.get_link(); }
                // 2. 尝试从页面变量中直接提取地址
                const links = Array.from(document.querySelectorAll('a')).map(a => a.href);
                const target = links.find(l => l.includes('pella.app/renew/'));
                if (target) { location.href = target; }
                // 3. 点击按钮
                const btn = document.querySelector('a.get-link, .btn-success, #getnewlink');
                if (btn) btn.click();
            }).catch(() => {});

            await sleep(2000);
            if (i % 5 === 0) console.log(`   ⏱️ 等待跳转中: ${page.url()}`);
        }

        if (capturedUrl) await page.goto(capturedUrl);

        await page.waitForURL(/pella\.app\/renew\//, { timeout: 20000 }).catch(() => {});
        if (page.url().includes('/renew/')) {
            console.log('🎉 续期成功！');
            await sendTG('✅ 续期动作已成功');
        } else {
            throw new Error('未到达最终页面: ' + page.url());
        }

    } catch (e) {
        await page.screenshot({ path: 'error.png' });
        console.error(`❌ 故障: ${e.message}`);
        await sendTG(`❌ 失败: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
