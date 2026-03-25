const { test, chromium } = require('@playwright/test');
const https = require('https');
const { execSync } = require('child_process');

const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const GLOBAL_TIMEOUT = 300000; // 5分钟总时长

// ── 广告拦截 ────────────────────────────────────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    window.open = () => ({ focus: () => {} });
    setInterval(() => {
        document.querySelectorAll('div[class*="overlay"], .popunder, iframe:not([src*="cloudflare"]), ins').forEach(el => el.remove());
    }, 1000);
})();
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendTG(result) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: `🎮 Pella 批量续期\n📊 结果: ${result}` });
    const req = https.request({ hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.write(body);
    req.end();
}

// ── 模拟真实点击 ─────────────────────────────────────────────
function xdotoolClick(x, y) {
    try {
        execSync(`xdotool mousemove ${Math.round(x)} ${Math.round(y)} click 1`, { timeout: 2000 });
        return true;
    } catch (e) { return false; }
}

// ── 针对 cuty.io / cuttlinks.com 的综合处理逻辑 ──────────────────
async function handleCutyChain(page) {
    let captured = null;
    page.on('request', req => { if (req.url().includes('pella.app/renew/')) captured = req.url(); });

    for (let i = 0; i < 40; i++) {
        if (captured || page.url().includes('pella.app/renew/')) break;

        // 处理 Cloudflare Turnstile
        const cfIframe = await page.$('iframe[src*="cloudflare"]');
        if (cfIframe) {
            const box = await cfIframe.boundingBox();
            if (box) {
                const info = await page.evaluate(() => ({ sx: window.screenX, sy: window.screenY, oh: window.outerHeight, ih: window.innerHeight }));
                const toolbar = (info.oh - info.ih) > 30 ? (info.oh - info.ih) : 85;
                xdotoolClick(box.x + 30 + info.sx, box.y + box.height / 2 + info.sy + toolbar);
                await sleep(3000);
            }
        }

        await page.evaluate(() => {
            const click = (s) => {
                const el = document.querySelector(s);
                if (el && !el.classList.contains('disabled')) { el.click(); return true; }
                return false;
            };
            click('#submit-button');
            click('p.getmylink');
            click('span.wp2continuelink');
            click('#continue');
            const gl = document.querySelector('#getnewlink') || document.querySelector('a.get-link');
            if (gl) { window.scrollTo(0, document.body.scrollHeight); gl.click(); }
        }).catch(() => {});

        await sleep(2500);
    }
    if (captured) await page.goto(captured);
    return page.url().includes('/renew/');
}

// ── 主程序 ──────────────────────────────────────────────────
test('Pella 自动续期 - 批量循环版', async () => {
    test.setTimeout(GLOBAL_TIMEOUT);
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();
    
    let processedLinks = new Set();
    let totalSuccess = 0;

    try {
        console.log('🔑 登录 Pella (使用 Enter 键触发)...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        
        // 填写邮箱
        await page.waitForSelector('input[type="text"], #identifier-field');
        await page.fill('input[type="text"], #identifier-field', PELLA_EMAIL);
        await page.keyboard.press('Enter');
        
        // 填写密码
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.keyboard.press('Enter');
        
        await page.waitForURL(/dashboard|home/, { timeout: 30000 });
        console.log('✅ 登录成功');

        for (let task = 1; task <= 3; task++) {
            console.log(`\n🚀 任务 ${task} 准备中...`);
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
            await sleep(3000);

            const token = await page.evaluate(() => window.Clerk?.session?.getToken());
            if (!token) { console.log('⚠️ 未能获取到 Token，尝试刷新'); continue; }

            const res = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            const target = (res.servers || [])
                .flatMap(s => s.renew_links || [])
                .find(l => !l.claimed && !processedLinks.has(l.link));

            if (!target) {
                console.log('🏁 列表已清空，无更多任务');
                break;
            }

            processedLinks.add(target.link);
            console.log(`🌐 正在处理: ${target.link}`);
            
            await page.goto(target.link, { waitUntil: 'domcontentloaded' });
            const ok = await handleCutyChain(page);

            if (ok) {
                totalSuccess++;
                console.log('✅ 续期指令已下达');
            } else {
                console.log('❌ 广告穿透失败');
            }
        }

        await sendTG(totalSuccess > 0 ? `成功处理 ${totalSuccess} 个任务` : "未完成续期任务");

    } catch (e) {
        console.error(`❌ 致命错误: ${e.message}`);
        await sendTG(`脚本崩溃: ${e.message}`);
    } finally {
        await browser.close();
    }
});
