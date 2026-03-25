const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 150000; // 增加超时容错

// ── 广告拦截脚本（针对 cuty.io 优化） ────────────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    window.open = () => null; // 禁止弹窗
    const removeAds = () => {
        // 移除 cuty.io 常见的浮层和干扰元素
        document.querySelectorAll('div[class*="overlay"], iframe:not([src*="cloudflare"]), .popunder').forEach(el => el.remove());
        // 移除按钮上的干扰 onclick
        document.querySelector('#submit-button')?.removeAttribute('onclick');
    };
    setInterval(removeAds, 1000);
})();
`;

// ── 工具函数 ────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function sendTG(result) {
    if (!TG_CHAT_ID || !TG_TOKEN) return Promise.resolve();
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: `🎮 Pella 续期任务\n📊 结果: ${result}\n⏰ 时间: ${new Date().toLocaleString()}` });
    return new Promise(resolve => {
        const req = https.request({ hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json' } }, resolve);
        req.on('error', resolve);
        req.write(body);
        req.end();
    });
}

// ── xdotool 物理点击 ────────────────────────────────────────
function xdotoolClick(x, y) {
    try {
        execSync(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} click 1`, { timeout: 2000 });
        return true;
    } catch (e) { return false; }
}

// ── 获取窗口坐标偏移 ────────────────────────────────────────
async function getOffset(page) {
    const info = await page.evaluate(() => ({
        sx: window.screenX,
        sy: window.screenY,
        oh: window.outerHeight,
        ih: window.innerHeight
    }));
    // 计算工具栏高度（浏览器上方地址栏+书签栏高度）
    let toolbar = info.oh - info.ih;
    if (toolbar < 30 || toolbar > 150) toolbar = 85; 
    return { x: info.sx, y: info.sy + toolbar };
}

// ── 处理 cuty.io 核心逻辑 ────────────────────────────────────
async function handleCutyIO(page) {
    console.log(`🔍 正在处理 cuty.io: ${page.url()}`);
    
    // 1. 等待并点击 "Verify you are human" / "Submit"
    try {
        await page.waitForSelector('#submit-button', { timeout: 15000 });
        // 有时按钮被干扰，先滚动到视野内
        await page.evaluate(() => document.querySelector('#submit-button').scrollIntoView());
        await sleep(1000);
        
        // 2. 处理 CF Turnstile
        const cfIframe = await page.$('iframe[src*="cloudflare"]');
        if (cfIframe) {
            console.log('🛡️ 发现 Cloudflare 验证框，尝试物理点击...');
            const box = await cfIframe.boundingBox();
            if (box) {
                const offset = await getOffset(page);
                // 点击验证框左侧的 "I am human" 选框位置
                xdotoolClick(box.x + 30 + offset.x, box.y + box.height / 2 + offset.y);
                await sleep(5000); 
            }
        }

        // 3. 点击提交按钮
        await page.click('#submit-button');
        console.log('✅ 已点击 Submit Button');
    } catch (e) {
        console.log('⚠️ Submit-button 步骤异常或已跳过');
    }

    // 4. 等待倒计时与 Get Link
    console.log('⏳ 等待 10 秒倒计时...');
    await sleep(12000);

    try {
        // cuty.io 结束后通常会出现一个 a 标签或按钮
        const getLinkIdx = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a, button'));
            const target = links.find(el => el.innerText.includes('Get Link') || el.id === 'get-link');
            if (target) { target.click(); return true; }
            return false;
        });
        if (getLinkIdx) console.log('✅ 已点击 Get Link');
    } catch (e) {
        console.log('⚠️ 未能找到 Get Link 按钮');
    }

    // 5. 等待最终跳转回 pella
    for (let i = 0; i < 10; i++) {
        if (page.url().includes('pella.app/renew/')) return true;
        await sleep(2000);
    }
    return false;
}

// ── 主程序 ──────────────────────────────────────────────────
test('Pella 自动续期 - 批量循环版', async () => {
    const browser = await chromium.launch({ 
        headless: false, 
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] 
    });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();

    try {
        // 1. 登录流程 (使用 Enter 键绕过不可见按钮问题)
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        await page.waitForSelector('input[type="text"], #identifier-field');
        await page.fill('input[type="text"], #identifier-field', PELLA_EMAIL);
        await page.keyboard.press('Enter');
        
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.keyboard.press('Enter');
        
        await page.waitForURL(/dashboard|home/, { timeout: 30000 });
        console.log('✅ 登录成功');

        // 2. 开始循环处理
        let successCount = 0;
        const processedLinks = new Set();

        for (let round = 1; round <= 5; round++) { // 最多尝试5个任务
            console.log(`\n🚀 开始第 ${round} 轮续期检查...`);
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
            await sleep(3000); // 等待异步数据加载

            // 获取 Token 和 服务器列表
            const token = await page.evaluate(() => window.Clerk?.session?.getToken());
            const serversRes = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            // 查找一个未领取的 cuty.io 链接
            let targetLink = null;
            for (const s of (serversRes.servers || [])) {
                const linkObj = (s.renew_links || []).find(l => !l.claimed && !processedLinks.has(l.link));
                if (linkObj) {
                    targetLink = linkObj.link;
                    break;
                }
            }

            if (!targetLink) {
                console.log('🏁 没有更多需要续期的链接了。');
                break;
            }

            processedLinks.add(targetLink);
            console.log(`🌐 访问续期地址: ${targetLink}`);
            
            await page.goto(targetLink);
            const isDone = await handleCutyIO(page);

            if (isDone || page.url().includes('/renew/')) {
                console.log('🎉 本轮续期成功！');
                successCount++;
            } else {
                console.log('❌ 本轮处理失败或超时');
            }
            
            await sleep(2000); 
        }

        await sendTG(successCount > 0 ? `成功续期 ${successCount} 台服务器` : "未发现待续期服务器或执行失败");

    } catch (e) {
        console.error(`❌ 脚本崩溃: ${e.message}`);
        await page.screenshot({ path: 'crash.png' });
        await sendTG(`脚本运行出错: ${e.message}`);
    } finally {
        await browser.close();
    }
});
