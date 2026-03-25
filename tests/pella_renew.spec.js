// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000;

// ── 针对 cuttlinks 的专项增强脚本 ──────────────────────────
const BYPASS_JS = `
(function() {
    'use strict';
    // 强制清理广告遮罩并激活按钮
    setInterval(() => {
        const badElements = document.querySelectorAll('div[class*="overlay"], .popunder, iframe[src*="google"]');
        badElements.forEach(el => el.remove());
        
        const selectors = ['#continue', '#getnewlink', 'a.get-link', '.btn-success', '.wp2continuelink', 'button#btn-main'];
        selectors.forEach(s => {
            const btn = document.querySelector(s);
            if (btn) {
                btn.classList.remove('disabled');
                btn.style.display = 'block';
                btn.style.pointerEvents = 'auto';
                btn.style.visibility = 'visible';
            }
        });
    }, 1000);
    window.open = () => null; 
})();
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const body = JSON.stringify({ 
            chat_id: TG_CHAT_ID, 
            text: `🎮 Pella 续期通知\n📊 结果: ${result}\n🕐 时间: ${new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})}` 
        });
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
    
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await context.addInitScript(BYPASS_JS);
    
    const page = await context.newPage();

    try {
        // 1. 登录 Pella
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.keyboard.press('Enter');
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.keyboard.press('Enter');
        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
        console.log('✅ 登录成功');

        // 2. 筛选链接：跳过 tpi.li，寻找可用链接
        await sleep(3000);
        const token = await page.evaluate('window.Clerk.session.getToken()');
        const res = await page.evaluate(async (t) => {
            const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
            return r.json();
        }, token);

        let renewLink = null;
        let selectedServer = '';

        for (const s of (res.servers || [])) {
            const links = s.renew_links || [];
            // 重点：排除 tpi.li，优先选择 cuttlinks.com
            const safeLinks = links.filter(l => !l.claimed && !l.link.includes('tpi.li'));
            const target = safeLinks.find(l => l.link.includes('cuttlinks.com')) || safeLinks[0];
            
            if (target) {
                renewLink = target.link;
                selectedServer = s.name || s.id;
                break;
            }
        }

        if (!renewLink) {
            console.log('⚠️ 所有的待续期链接均为 tpi.li 或已领取。');
            console.log('⏩ 脚本将跳过本次执行，等待 Pella 分发 cuttlinks 链接。');
            return;
        }

        console.log(`🌐 正在续期服务器: ${selectedServer}`);
        console.log(`🌐 访问有效链接: ${renewLink}`);

        // 📡 开启网络嗅探，一旦发现最终跳转地址立刻截获
        let capturedUrl = null;
        page.on('request', req => {
            if (req.url().includes('pella.app/renew/')) {
                capturedUrl = req.url();
                console.log('🎯 捕获到目标跳转: ' + capturedUrl);
            }
        });

        await page.goto(renewLink, { waitUntil: 'domcontentloaded' });

        // 3. 处理跳转逻辑
        console.log('⏳ 正在处理跳转穿透...');
        for (let i = 0; i < 40; i++) {
            if (capturedUrl || page.url().includes('pella.app/renew/')) break;

            // 针对 cuttlinks 执行暴力点击
            await page.evaluate(() => {
                const btnSelectors = ['#continue', '#getnewlink', 'a.get-link', '.btn-success', '.wp2continuelink'];
                btnSelectors.forEach(s => {
                    const el = document.querySelector(s);
                    if (el && !el.classList.contains('disabled')) el.click();
                });
                if (typeof window.get_link === 'function') window.get_link();
            }).catch(() => {});

            await sleep(2000);
            if (i % 5 === 0) console.log(`   ⏱️ 当前页面: ${page.url()}`);
        }

        // 4. 最终确认
        if (capturedUrl) await page.goto(capturedUrl);

        await page.waitForURL(/pella\.app\/renew\//, { timeout: 15000 }).catch(() => {});
        if (page.url().includes('/renew/')) {
            console.log('🎉 任务完成！');
            await sendTG(`✅ 服务器 ${selectedServer} 续期成功 (避开了 tpi.li)`);
        } else {
            throw new Error('未到达续期完成页，当前: ' + page.url());
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
