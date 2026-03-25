// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 150000; // 增加到 150 秒以防万一

// ── 广告与遮罩层拦截脚本 ────────────────────────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    function removeAds() {
        // 移除 cuty.io 常见的全屏透明遮挡层
        document.querySelectorAll('div[style*="z-index: 2147483647"], .popunder, .ad-overlay').forEach(el => el.remove());
        // 确保按钮始终在最前面
        const btn = document.querySelector('#submit-button');
        if (btn) {
            btn.style.zIndex = '99999';
            btn.style.position = 'relative';
        }
    }
    window.open = () => null; // 阻止弹窗
    new MutationObserver(removeAds).observe(document.documentElement, { childList: true, subtree: true });
})();
`;

// ── 工具函数 ────────────────────────────────────────────────
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

// ── 处理 CF Turnstile (I am not a robot) ─────────────────────
async function solveTurnstile(page) {
    console.log('🛡️ 正在处理 Cloudflare 人机验证...');
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
        console.log(`📐 xdotool 模拟点击验证框: (${absX}, ${absY})`);
        await sleep(8000); // 验证通常需要几秒
        return true;
    }
    return false;
}

// ── Cuty.io 核心处理逻辑 ────────────────────────────────────
async function handleCutyIo(page) {
    console.log('🌐 进入 Cuty.io 解析流程...');
    
    // 1. 点击初始的 Submit Button
    try {
        await page.waitForSelector('#submit-button', { timeout: 15000 });
        console.log('🖱️ 点击 submit-button...');
        await page.click('#submit-button', { force: true });
    } catch (e) {
        console.log('⚠️ 未找到 submit-button，尝试继续...');
    }

    await sleep(3000);

    // 2. 处理 Turnstile (I am not a robot)
    const hasCF = await page.locator('.cf-turnstile, iframe[src*="cloudflare"]').count();
    if (hasCF > 0) {
        await solveTurnstile(page);
    }

    // 3. 等待倒计时
    console.log('⏳ 等待倒计时结束 (约 10-15s)...');
    await sleep(15000);

    // 4. 点击最终的 Go / Get Link
    const goSelectors = ['button:has-text("Go")', 'a:has-text("Go")', 'a:has-text("Get Link")', '#get-link'];
    for (const selector of goSelectors) {
        try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible()) {
                console.log(`🚀 点击放行按钮: ${selector}`);
                await btn.click({ force: true });
                return true;
            }
        } catch (e) {}
    }
    return false;
}

// ── 主程序 ──────────────────────────────────────────────────
test('Pella 全自动化集群维护协议', async () => {
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    try {
        // 1. 登录
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login');
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('button.cl-formButtonPrimary');
        await page.waitForSelector('input[name="password"]');
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('button.cl-formButtonPrimary');
        await page.waitForURL(/dashboard|home/);
        console.log('✅ 登录成功');

        // 2. 任务循环
        let taskActive = true;
        while (taskActive) {
            console.log('📡 刷新服务器列表...');
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
            await sleep(2000);

            // 获取 API 数据判定哪些没领
            const token = await page.evaluate(() => window.Clerk?.session?.getToken());
            const serversRes = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            const server = serversRes.servers?.find(s => s.renew_links?.some(l => !l.claimed));
            
            if (!server) {
                console.log('🎉 所有服务器已续期完成！');
                taskActive = false;
                break;
            }

            const targetLink = server.renew_links.find(l => !l.claimed).link;
            console.log(`📌 锁定目标: [${server.ip}] -> ${targetLink}`);

            // 跳转到广告页
            await page.goto(targetLink);
            await sleep(3000);

            const currentUrl = page.url();
            
            // 路由判断
            if (currentUrl.includes('cuty.io')) {
                await handleCutyIo(page);
            } else {
                console.log('⚠️ 发现非 Cuty.io 链接 (如 tpi.li)，尝试寻找跳转按钮...');
                await page.click('#continue, .btn-success').catch(() => {});
                await sleep(5000);
                if (page.url().includes('cuty.io')) await handleCutyIo(page);
            }

            // 验证是否返回 Pella
            try {
                await page.waitForURL(/pella\.app\/renew\//, { timeout: 25000 });
                console.log('✨ 该节点续期指令已触发，准备下一轮...');
            } catch (e) {
                console.log('⚠️ 未检测到自动跳转回 Pella，强制返回服务器列表重新开始。');
            }
            
            await sleep(2000);
        }

    } catch (e) {
        console.error(`💥 脚本报错: ${e.message}`);
        await page.screenshot({ path: 'error_debug.png' });
        throw e;
    } finally {
        await browser.close();
    }
});
