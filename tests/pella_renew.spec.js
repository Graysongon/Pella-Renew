// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const { execSync } = require('child_process');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

// ── 广告拦截与元素清洗 ──────────────────────────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    function removeAds() {
        // 移除可能遮挡按钮的透明层和弹窗 (cuty.io & tpi.li 通用)
        document.querySelectorAll('div[style*="z-index: 2147483647"], .popunder, .ad-overlay, iframe[src*="vidoza"]').forEach(el => el.remove());
        const cutyBtn = document.querySelector('#submit-button');
        if (cutyBtn) cutyBtn.style.zIndex = '9999';
        const tpiBtn = document.querySelector('#continue');
        if (tpiBtn) tpiBtn.style.zIndex = '9999';
    }
    window.open = () => null; 
    new MutationObserver(removeAds).observe(document.documentElement, { childList: true, subtree: true });
})();
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getWindowOffset(page) {
    try {
        const geo = execSync('xdotool getwindowgeometry --shell $(xdotool getactivewindow)').toString();
        const geoDict = {};
        geo.split('\n').forEach(l => { const [k, v] = l.split('='); if(k) geoDict[k] = parseInt(v); });
        const info = await page.evaluate(() => ({ outer: window.outerHeight, inner: window.innerHeight }));
        return { winX: geoDict['X'] || 0, winY: geoDict['Y'] || 0, toolbar: (info.outer - info.inner) || 85 };
    } catch (e) { return { winX: 0, winY: 0, toolbar: 85 }; }
}

// ── 处理 CF Turnstile 验证 ──────────────────────────────────
async function solveTurnstile(page) {
    console.log('🛡️ 正在尝试穿透 Cloudflare 验证...');
    await sleep(3000);
    const coords = await page.evaluate(() => {
        const el = document.querySelector('.cf-turnstile') || document.querySelector('iframe[src*="cloudflare"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left + 50, y: rect.top + (rect.height / 2) };
    });
    if (coords) {
        const { winX, winY, toolbar } = await getWindowOffset(page);
        const absX = Math.round(coords.x + winX);
        const absY = Math.round(coords.y + winY + toolbar);
        execSync(`xdotool mousemove ${absX} ${absY} click 1`);
        console.log(`📐 xdotool 模拟点击验证: (${absX}, ${absY})`);
        await sleep(6000);
    }
}

// ── 处理 Cuty.io 逻辑 ──────────────────────────────────────
async function handleCuty(page) {
    console.log(`🌐 正在处理 Cuty.io 流程...`);
    try {
        await page.waitForSelector('#submit-button', { timeout: 15000 });
        await page.click('#submit-button', { force: true });
        await sleep(3000);
        
        if (await page.locator('.cf-turnstile').isVisible()) {
            await solveTurnstile(page);
        }

        console.log('⏳ 等待倒计时及跳转按钮...');
        await sleep(12000);
        // Cuty 可能显示 "Go" 或 "Get Link"
        const finalBtn = page.locator('a:has-text("Get Link"), button:has-text("Go"), a:has-text("GO")').first();
        await finalBtn.click({ timeout: 10000 });
        return true;
    } catch (e) {
        console.log(`❌ Cuty.io 失败: ${e.message}`);
        return false;
    }
}

// ── 处理 Tpi.li 逻辑 ───────────────────────────────────────
async function handleTpi(page) {
    console.log(`🌐 正在处理 Tpi.li 流程...`);
    try {
        await page.waitForSelector('#continue', { timeout: 15000 });
        await page.click('#continue');
        await sleep(2000);
        
        if (await page.locator('.cf-turnstile').isVisible()) {
            await solveTurnstile(page);
        }
        
        console.log('⏳ 等待 Tpi 倒计时...');
        await sleep(10000);
        const getLink = page.locator('a.btn-success:has-text("Get Link")');
        await getLink.waitFor({ state: 'visible' });
        await getLink.click();
        return true;
    } catch (e) {
        console.log(`❌ Tpi.li 失败: ${e.message}`);
        return false;
    }
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 自动续期任务', async () => {
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    try {
        // 1. 登录
        console.log('🔑 访问登录页面...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'domcontentloaded' });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('button.cl-formButtonPrimary');
        
        const pwdInput = page.locator('input[name="password"]');
        await pwdInput.waitFor({ state: 'visible' });
        // 确保 password 框已启用
        await page.waitForFunction(() => !document.querySelector('input[name="password"]').disabled);
        await pwdInput.fill(PELLA_PASSWORD);
        await page.click('button.cl-formButtonPrimary');

        await page.waitForURL(/dashboard|home/, { timeout: 30000 });
        console.log('✅ 登录成功');

        // 2. 任务循环
        let counter = 0;
        while (counter < 10) { // 最多处理10个任务防止死循环
            counter++;
            console.log(`🔍 正在检索第 ${counter} 个续期任务...`);
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
            
            const token = await page.evaluate(() => window.Clerk?.session?.getToken());
            const serversRes = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            const server = serversRes.servers?.find(s => s.renew_links?.some(l => !l.claimed));
            if (!server) {
                console.log('🎉 今日任务全部完成！');
                break;
            }

            const targetLink = server.renew_links.find(l => !l.claimed).link;
            console.log(`🔗 服务器: ${server.ip} -> 访问: ${targetLink}`);

            await page.goto(targetLink);
            await sleep(3000);

            // 识别平台并处理
            const currentUrl = page.url();
            if (currentUrl.includes('cuty.io')) {
                await handleCuty(page);
            } else if (currentUrl.includes('tpi.li')) {
                await handleTpi(page);
            } else {
                console.log('⚠️ 遇到未知平台，尝试通用点击');
                await page.click('#continue, button:has-text("Continue")').catch(() => {});
            }

            // 关键：等待重定向回 Pella 并验证结果
            try {
                await page.waitForURL(/pella\.app\/renew\//, { timeout: 25000 });
                console.log('✅ 续期完成，准备下一个...');
                await sleep(2000);
            } catch (e) {
                console.log('⚠️ 未能检测到跳转回 Pella，可能需要手动重置页面');
            }
        }

    } catch (e) {
        console.error(`💥 运行中断: ${e.message}`);
        await page.screenshot({ path: 'debug_error.png' });
        throw e;
    } finally {
        await browser.close();
    }
});
