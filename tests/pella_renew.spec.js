// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');
const TIMEOUT = 100000; 

const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    function clean() {
        // 移除 cuty.io 的透明广告遮罩
        document.querySelectorAll('div[style*="z-index: 2147483647"], .popunder, .ad-overlay').forEach(el => el.remove());
        const btn = document.querySelector('#submit-button');
        if (btn) btn.style.zIndex = '99999';
    }
    window.open = () => null;
    setInterval(clean, 1000);
})();
`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── 硬件点击工具 ──────────────────────────────────────────────
async function xdotoolClick(page, selector) {
    try {
        const rect = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }, selector);

        if (rect) {
            // 获取窗口偏移（简单处理，通常 xvfb 下偏移固定）
            const winX = 0, winY = 0, toolbar = 85; 
            const absX = Math.round(rect.x + winX);
            const absY = Math.round(rect.y + winY + toolbar);
            execSync(`xdotool mousemove ${absX} ${absY} click 1`);
            return true;
        }
    } catch (e) {}
    return false;
}

// ── Cuty.io 核心逻辑 ─────────────────────────────────────────
async function handleCutyIo(page) {
    console.log('🌐 正在解析 Cuty.io 链路...');
    
    // 1. 点击 Submit
    try {
        await page.waitForSelector('#submit-button', { timeout: 15000 });
        console.log('🖱️ 点击 #submit-button');
        await page.click('#submit-button', { force: true, delay: 200 });
    } catch (e) {
        console.log('⚠️ 未找到 submit 按钮，可能已跳过');
    }

    await sleep(3000);

    // 2. 处理 Turnstile (I am not a robot)
    const cfFrame = page.locator('iframe[src*="cloudflare"]');
    if (await cfFrame.count() > 0) {
        console.log('🛡️ 检测到 Cloudflare 验证，尝试物理点击...');
        await xdotoolClick(page, 'iframe[src*="cloudflare"]');
        await sleep(10000); // 等待验证通过和倒计时加载
    }

    // 3. 等待倒计时并寻找 Go 按钮
    console.log('⏳ 等待倒计时结束...');
    await sleep(12000); 

    const goButtons = ['#get-link', 'button:has-text("Go")', 'a:has-text("Go")', '.btn-success'];
    for (const sel of goButtons) {
        if (await page.locator(sel).isVisible()) {
            console.log(`🚀 点击放行按钮: ${sel}`);
            await page.click(sel, { force: true });
            break;
        }
    }
}

// ── 主测试流程 ────────────────────────────────────────────────
test('Pella 全自动化集群维护协议', async () => {
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();

    try {
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login');
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('button.cl-formButtonPrimary');
        await page.waitForSelector('input[name="password"]');
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('button.cl-formButtonPrimary');
        await page.waitForURL(/dashboard|home/);
        console.log('✅ 登录成功');

        let iteration = 0;
        while (iteration < 5) { // 最多处理5个需要续期的节点
            iteration++;
            console.log(`\n🔄 第 ${iteration} 轮更新作业...`);
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
            await sleep(3000);

            const token = await page.evaluate(() => window.Clerk?.session?.getToken());
            const data = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            const server = data.servers?.find(s => s.renew_links?.some(l => !l.claimed));
            if (!server) {
                console.log('🎉 所有节点已处于最佳状态，任务结束。');
                break;
            }

            let rawLink = server.renew_links.find(l => !l.claimed).link;
            
            // 🔥 关键：强制转换域名 tpi.li -> cuty.io
            let targetLink = rawLink.replace('tpi.li', 'cuty.io');
            console.log(`📌 锁定目标: [${server.ip}]`);
            console.log(`🔗 原始链接: ${rawLink}`);
            console.log(`🚀 强制跳转: ${targetLink}`);

            await page.goto(targetLink);
            await sleep(5000);

            // 执行 Cuty.io 处理流程
            await handleCutyIo(page);

            // 检查结果
            try {
                await page.waitForURL(/pella\.app\/renew\//, { timeout: 20000 });
                console.log('✅ 该节点续期成功！');
            } catch (e) {
                console.log('⚠️ 续期跳转确认超时，返回主列表尝试下一个。');
            }
        }

    } catch (e) {
        console.error(`💥 脚本异常: ${e.message}`);
        await page.screenshot({ path: 'error_debug.png' });
    } finally {
        await browser.close();
    }
});
