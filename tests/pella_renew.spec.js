// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 300000;

// ── 核心拦截脚本：封杀所有弹出窗口和重定向 ──────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    window.open = () => { return { focus: () => {} }; }; // 拦截并模拟成功，防止脚本报错
    
    // 强制清理遮罩层
    setInterval(() => {
        document.querySelectorAll('div[class*="overlay"], .popunder, iframe, ins').forEach(el => {
            if (!el.src || !el.src.includes('cloudflare')) el.remove();
        });
    }, 800);
})();
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: `🎮 Pella 续期: ${result}` });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`, method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, () => resolve());
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

// ── 针对 Cuttlinks 的专项点击模式 ──────────────────────────
async function handleAdLink(page) {
    console.log(`  📄 目标: ${page.url()}`);
    let captured = null;
    page.on('request', req => {
        if (req.url().includes('pella.app/renew/')) captured = req.url();
    });

    for (let i = 0; i < 50; i++) {
        if (captured || page.url().includes('pella.app/renew/')) break;

        await page.evaluate(() => {
            const click = (sel) => {
                const el = document.querySelector(sel);
                if (el && !el.classList.contains('disabled') && el.style.display !== 'none') {
                    el.click();
                    return true;
                }
                return false;
            };

            // 1. 第一阶段：点击 Continue (可能会变形成 p.getmylink)
            click('p.getmylink');
            click('#submit-button');

            // 2. 第二阶段：点击跳转 (Cuttlinks 特有)
            click('span.wp2continuelink');

            // 3. 第三阶段：滚动到底部点 Get Link
            const getLink = document.querySelector('#getnewlink') || document.querySelector('a.get-link');
            if (getLink) {
                window.scrollTo(0, document.body.scrollHeight);
                getLink.click();
            }

            // 4. 原生函数触发
            if (typeof window.get_link === 'function') window.get_link();
        }).catch(() => {});

        await sleep(2000);
        if (i % 5 === 0) {
            // 每 10 秒强制滚一下，触发懒加载
            await page.mouse.wheel(0, 500);
            console.log(`    ⏱️ 穿透中... [${page.url().substring(0, 40)}]`);
        }
    }

    if (captured) {
        console.log('🎯 捕获到跳转 URL，强制导航...');
        await page.goto(captured);
    }
    
    await page.waitForURL(/pella\.app\/renew\//, { timeout: 10000 }).catch(() => {});
    return page.url().includes('/renew/');
}

// ── 主程序保持不变，加入 processedLinks 逻辑 ──────────────────
test('Pella 自动续期 - 批量任务版', async () => {
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
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();

    let processedLinks = new Set();

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

        let successCount = 0;
        let attempt = 0;

        while (attempt < 4) {
            await sleep(3000);
            const token = await page.evaluate('window.Clerk.session.getToken()');
            const res = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            const targetLink = (res.servers || [])
                .flatMap(s => s.renew_links || [])
                .find(l => !l.claimed && !l.link.includes('tpi.li') && !processedLinks.has(l.link));

            if (!targetLink) break;

            attempt++;
            processedLinks.add(targetLink.link);
            console.log(`🚀 任务 ${attempt}: ${targetLink.link}`);

            await page.goto(targetLink.link, { waitUntil: 'domcontentloaded' });
            const isOk = await handleAdLink(page);
            
            if (isOk) {
                successCount++;
                console.log(`✅ 成功！`);
            } else {
                console.log(`❌ 失败。`);
            }

            console.log('🔙 返回列表...');
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
        }

        await sendTG(successCount > 0 ? `批量任务完成：成功 ${successCount} 个` : "全部处理失败");

    } catch (e) {
        console.error(`❌ 异常: ${e.message}`);
        await sendTG(`❌ 脚本崩溃: ${e.message}`);
    } finally {
        await browser.close();
    }
});
