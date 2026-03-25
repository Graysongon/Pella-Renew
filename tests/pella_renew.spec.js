// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const { execSync } = require('child_process');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

// ── 广告拦截与元素清洗（针对 cuty.io） ──────────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    function removeAds() {
        // 移除可能遮挡按钮的透明层和弹窗
        document.querySelectorAll('div[style*="z-index: 2147483647"], .popunder, .ad-overlay').forEach(el => el.remove());
        const btn = document.querySelector('#submit-button');
        if (btn) btn.style.zIndex = '9999';
    }
    window.open = () => null; 
    new MutationObserver(removeAds).observe(document.documentElement, { childList: true, subtree: true });
})();
`;

// ── 工具函数 ────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendTG(text) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: `🎮 Pella 自动续期:\n${text}` });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    }, (res) => {});
    req.write(body); req.end();
}

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
    console.log('🛡️ 检测到 Cloudflare 验证，尝试点击...');
    await sleep(3000);
    const coords = await page.evaluate(() => {
        const el = document.querySelector('.cf-turnstile') || document.querySelector('iframe[src*="cloudflare"]');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.left + 45, y: rect.top + (rect.height / 2) };
    });
    if (coords) {
        const { winX, winY, toolbar } = await getWindowOffset(page);
        const absX = Math.round(coords.x + winX);
        const absY = Math.round(coords.y + winY + toolbar);
        execSync(`xdotool mousemove ${absX} ${absY} click 1`);
        console.log(`📐 xdotool 模拟点击: (${absX}, ${absY})`);
        await sleep(5000);
    }
}

// ── 处理 Cuty.io 逻辑 ──────────────────────────────────────
async function handleCuty(page) {
    console.log(`🌐 正在处理 Cuty.io: ${page.url()}`);
    try {
        // 1. 等待提交按钮进入可点击状态
        const submitBtn = page.locator('#submit-button');
        await submitBtn.waitFor({ state: 'visible', timeout: 15000 });
        await sleep(1000);
        await submitBtn.click({ force: true });
        
        // 2. 检查验证
        await sleep(2000);
        if (await page.locator('.cf-turnstile').isVisible()) {
            await solveTurnstile(page);
        }

        // 3. 等待倒计时及最终跳转按钮
        console.log('⏳ 等待 10 秒倒计时...');
        await sleep(12000);
        const getLinkBtn = page.locator('a:has-text("Get Link"), button:has-text("Go")').first();
        await getLinkBtn.click({ timeout: 10000 }).catch(() => console.log('⚠️ 尝试强制点击 Go 按钮'));
        return true;
    } catch (e) {
        console.log(`❌ Cuty.io 处理失败: ${e.message}`);
        return false;
    }
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 自动续期任务', async () => {
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    try {
        // 1. 登录流程优化
        console.log('🔑 访问登录页面...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('button.cl-formButtonPrimary'); // 统一使用 Clerk 的类名点击

        await sleep(3000);
        
        // 防御：如果检测到跳转至 Google 登录
        if (page.url().includes('google.com')) {
            throw new Error('检测到账号绑定了 Google 登录，请使用普通邮箱密码账号或预先注入 Cookie。');
        }

        // 等待密码框启用
        console.log('✏️ 填写密码...');
        const pwdInput = page.locator('input[name="password"]');
        await pwdInput.waitFor({ state: 'attached' });
        // 循环等待直到 password 框不再是 disabled
        for(let i=0; i<10; i++) {
            const isDisabled = await pwdInput.getAttribute('disabled');
            if (isDisabled === null) break;
            await sleep(1000);
        }
        await pwdInput.fill(PELLA_PASSWORD);
        await page.click('button.cl-formButtonPrimary');

        await page.waitForURL(/dashboard|home/, { timeout: 30000 });
        console.log('✅ 登录成功');

        // 2. 自动化续期循环
        let taskFinished = false;
        while (!taskFinished) {
            console.log('🔍 获取服务器列表...');
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
            
            const token = await page.evaluate(() => window.Clerk?.session?.getToken());
            if (!token) throw new Error('未能获取 Clerk Token');

            const serversRes = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            // 寻找未领取的续期链接
            const server = serversRes.servers?.find(s => s.renew_links?.some(l => !l.claimed));
            if (!server) {
                console.log('🎉 所有服务器今日已续期！');
                await sendTG('所有服务器已续期完毕');
                taskFinished = true;
                break;
            }

            const targetLink = server.renew_links.find(l => !l.claimed).link;
            console.log(`🔗 处理服务器 ${server.ip}，链接: ${targetLink}`);

            await page.goto(targetLink);
            await sleep(3000);

            // 区分平台处理
            if (page.url().includes('cuty.io')) {
                await handleCuty(page);
            } else {
                console.log('⚠️ 未知跳转目标，尝试查找通用按钮');
                await page.click('button:has-text("Continue"), #continue').catch(() => {});
            }

            // 验证是否返回成功页
            try {
                await page.waitForURL(/pella\.app\/renew\//, { timeout: 20000 });
                console.log(`✅ ${server.ip} 续期流程触发成功`);
                await sleep(2000);
            } catch (e) {
                console.log(`⚠️ 续期跳转确认超时，尝试下一次循环。当前URL: ${page.url()}`);
            }
        }

    } catch (e) {
        console.error(`💥 脚本报错: ${e.message}`);
        await page.screenshot({ path: 'error_debug.png' });
        await sendTG(`脚本异常: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
