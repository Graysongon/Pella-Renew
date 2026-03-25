// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

// ── 广告拦截与元素清洗（针对 cuty.io 优化） ────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    const blockedDomains = ['madurird.com', 'crn77.com', 'fqjiujafk.com', 'popads', 'avnsgames'];
    
    function removeAds() {
        // 移除干扰点击的透明层和弹窗
        document.querySelectorAll('div[class*="overflow"], div[style*="z-index: 2147483647"]').forEach(el => el.remove());
        // 确保按钮没有被覆盖
        const submitBtn = document.querySelector('#submit-button');
        if (submitBtn) {
            submitBtn.removeAttribute('onclick');
            submitBtn.style.zIndex = '9999';
        }
    }

    window.open = () => null; // 阻止弹窗
    new MutationObserver(removeAds).observe(document.documentElement, { childList: true, subtree: true });
})();
`;

// ── 工具函数 ────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTG(result, extra = '') {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: `🎮 Pella 续期: ${result}\n${extra}` });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => resolve());
        req.write(body);
        req.end();
    });
}

// 获取窗口偏移（用于 xdotool 绝对点击）
async function getWindowOffset(page) {
    try {
        const geo = execSync('xdotool getwindowgeometry --shell $(xdotool getactivewindow)').toString();
        const geoDict = {};
        geo.split('\n').forEach(l => { const [k, v] = l.split('='); if(k) geoDict[k] = parseInt(v); });
        const info = await page.evaluate(() => ({ outer: window.outerHeight, inner: window.innerHeight }));
        return { winX: geoDict['X'] || 0, winY: geoDict['Y'] || 0, toolbar: info.outer - info.inner || 80 };
    } catch (e) { return { winX: 0, winY: 0, toolbar: 80 }; }
}

// ── 处理 CF Turnstile ──────────────────────────────────────
async function solveTurnstile(page) {
    console.log('🛡️ 正在处理 Turnstile 验证...');
    await sleep(2000);
    const coords = await page.evaluate(() => {
        const container = document.querySelector('.cf-turnstile') || document.querySelector('iframe[src*="cloudflare"]');
        if (!container) return null;
        const rect = container.getBoundingClientRect();
        // 点击 Turnstile 典型的复选框中心位置 (左侧约 30-50 像素)
        return { x: rect.left + 35, y: rect.top + (rect.height / 2) };
    });

    if (coords) {
        const offset = await getWindowOffset(page);
        const absX = Math.round(coords.x + offset.winX);
        const absY = Math.round(coords.y + offset.winY + offset.toolbar);
        execSync(`xdotool mousemove ${absX} ${absY} click 1`);
        console.log(`📐 已点击验证位: (${absX}, ${absY})`);
        await sleep(5000);
        return true;
    }
    return false;
}

// ── 核心逻辑：处理 Cuty.io ──────────────────────────────────
async function handleCuty(page) {
    console.log(`🌐 进入 Cuty.io: ${page.url()}`);
    
    // 1. 等待并点击 "Verify / Submit" 按钮
    try {
        await page.waitForSelector('#submit-button', { timeout: 15000 });
        await page.click('#submit-button');
        console.log('✅ 点击 Submit Button');
    } catch (e) {
        console.log('⚠️ 未直接发现 Submit，尝试滚动查找');
        await page.evaluate(() => window.scrollTo(0, 800));
        await page.click('#submit-button').catch(() => {});
    }

    await sleep(3000);

    // 2. 检测并处理 CF 验证
    const hasCF = await page.evaluate(() => !!document.querySelector('.cf-turnstile'));
    if (hasCF) await solveTurnstile(page);

    // 3. 等待倒计时并点击 Go
    console.log('⏳ 等待倒计时...');
    try {
        // Cuty 通常有一个 #count 元素或者直接等待按钮变成可点击
        await sleep(10000); 
        const goBtn = page.locator('a:has-text("Get Link"), button:has-text("Go")').first();
        await goBtn.waitFor({ state: 'visible', timeout: 20000 });
        await goBtn.click();
        console.log('✅ 点击 Go/Get Link');
    } catch (e) {
        console.log('❌ 无法完成 Cuty 流程');
        return false;
    }
    return true;
}

// ── 主程序 ──────────────────────────────────────────────────
test('Pella 自动续期 - Cuty 版', async () => {
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();

    try {
        // 1. 登录
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login');
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('button:has-text("Continue")');
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('button:has-text("Continue")');
        await page.waitForURL(/dashboard|home/);

        // 2. 循环处理所有需要续期的服务器
        let hasMore = true;
        while (hasMore) {
            console.log('🔍 检查续期任务...');
            const token = await page.evaluate(() => window.Clerk.session.getToken());
            const serversRes = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            const server = serversRes.servers?.find(s => s.renew_links?.some(l => !l.claimed));
            
            if (!server) {
                console.log('🎉 所有服务器已续期完毕');
                hasMore = false;
                break;
            }

            const renewLink = server.renew_links.find(l => !l.claimed).link;
            console.log(`🔗 准备处理链接: ${renewLink}`);

            await page.goto(renewLink);
            
            // 处理 cuty.io 或中转
            if (page.url().includes('cuty.io')) {
                await handleCuty(page);
            }

            // 等待返回 Pella 成功页面
            try {
                await page.waitForURL(/pella\.app\/renew\//, { timeout: 30000 });
                const success = await page.content().then(c => c.includes('successfully') || c.includes('Renewed'));
                
                if (success) {
                    console.log(`✅ 服务器 ${server.ip} 续期成功！`);
                    await sendTG(`服务器 ${server.ip} 续期成功`);
                    // 关键：成功后返回列表页，准备下一次循环
                    await page.goto('https://www.pella.app/servers');
                    await sleep(3000);
                }
            } catch (e) {
                console.log('❌ 续期确认跳转失败');
                hasMore = false; 
            }
        }

    } catch (e) {
        console.error(`💥 运行异常: ${e.message}`);
        await sendTG(`脚本异常: ${e.message}`);
    } finally {
        await browser.close();
    }
});
