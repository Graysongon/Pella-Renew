const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 300000; // 批量任务增加到5分钟

// ── 广告拦截与弹窗封杀 ──────────────────────────────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    window.open = () => ({ focus: () => {} });
    setInterval(() => {
        document.querySelectorAll('div[class*="overlay"], .popunder, iframe:not([src*="cloudflare"]), ins').forEach(el => el.remove());
    }, 1000);
})();
`;

const CF_TOKEN_LISTENER_JS = `
(function() {
    if (window.__cf_token_listener_injected__) return;
    window.__cf_token_listener_injected__ = true;
    window.addEventListener('message', function(e) {
        if (e.data && e.data.event === 'complete' && e.data.token) {
            window.__cf_turnstile_token__ = e.data.token;
        }
    });
})();
`;

// ── 工具函数 ────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function sendTG(result) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: `🎮 Pella 批量续期\n📊 结果: ${result}\n⏰ ${new Date().toLocaleString()}` });
    const req = https.request({ hostname: 'api.telegram.org', path: `/bot${TG_TOKEN}/sendMessage`, method: 'POST', headers: { 'Content-Type': 'application/json' } });
    req.write(body);
    req.end();
}

function xdotoolClick(x, y) {
    try {
        const wids = execSync('xdotool search --onlyvisible --class chrome').toString().trim().split('\n');
        if (wids.length > 0) execSync(`xdotool windowactivate ${wids[wids.length - 1]}`);
        execSync(`xdotool mousemove ${x} ${y} click 1`);
        return true;
    } catch (e) { return false; }
}

// ── CF Turnstile 穿透 (针对 cuty.io 优化) ──────────────────────
async function solveTurnstile(page) {
    await page.evaluate(CF_TOKEN_LISTENER_JS);
    await sleep(2000);

    // 获取 Turnstile 容器位置
    const coords = await page.evaluate(() => {
        const f = document.querySelector('iframe[src*="cloudflare"]');
        if (!f) return null;
        const r = f.getBoundingClientRect();
        return { x: r.x + 30, y: r.y + r.height / 2 }; // 点击左侧复选框位置
    });

    if (coords) {
        console.log('📐 尝试点击 CF 验证框...');
        const info = await page.evaluate(() => ({ sx: window.screenX, sy: window.screenY, oh: window.outerHeight, ih: window.innerHeight }));
        const toolbar = (info.oh - info.ih) > 30 ? (info.oh - info.ih) : 80;
        xdotoolClick(coords.x + info.sx, coords.y + info.sy + toolbar);
    }

    // 等待 Token 出现
    for (let i = 0; i < 30; i++) {
        const ok = await page.evaluate(() => {
            const val = document.querySelector('input[name="cf-turnstile-response"]')?.value;
            return (val && val.length > 20) || !!window.__cf_turnstile_token__;
        });
        if (ok) return true;
        await sleep(1000);
    }
    return false;
}

// ── Cuty / Cuttlinks 点击逻辑 ────────────────────────────────
async function handleCutyChain(page) {
    console.log(`  📄 处理链接: ${page.url()}`);
    let captured = null;
    page.on('request', req => { if (req.url().includes('pella.app/renew/')) captured = req.url(); });

    for (let i = 0; i < 40; i++) {
        if (captured || page.url().includes('pella.app/renew/')) break;

        // 检查是否有 CF 验证
        const hasCF = await page.evaluate(() => !!document.querySelector('iframe[src*="cloudflare"]'));
        if (hasCF) await solveTurnstile(page);

        await page.evaluate(() => {
            const click = (s) => document.querySelector(s)?.click();
            // Cuty / Cuttlinks 常见按钮
            click('#submit-button');
            click('p.getmylink');
            click('span.wp2continuelink');
            click('#continue');
            const gl = document.querySelector('#getnewlink') || document.querySelector('a.get-link');
            if (gl) { window.scrollTo(0, document.body.scrollHeight); gl.click(); }
        }).catch(() => {});

        await sleep(2500);
        if (i % 5 === 0) console.log(`    ⏱️ 等待中... ${page.url().substring(0, 30)}`);
    }

    if (captured) await page.goto(captured);
    return page.url().includes('/renew/');
}

// ── 主程序 ──────────────────────────────────────────────────
test('Pella 自动续期 - 批量循环版', async () => {
    const browser = await chromium.launch({ headless: false, args: ['--no-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();
    
    let processedLinks = new Set();
    let totalSuccess = 0;

    try {
        // 1. 登录
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login');
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('button[type="submit"]');
        await page.waitForSelector('input[name="password"]');
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('button[type="submit"]');
        await page.waitForURL(/dashboard|home/);
        console.log('✅ 登录成功');

        // 2. 批量任务循环
        for (let task = 1; task <= 3; task++) { // 最多连续处理3个
            console.log(`\n🚀 开始第 ${task} 个任务...`);
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
            await sleep(2000);

            // 获取最新 JWT 并抓取服务器列表
            const token = await page.evaluate('window.Clerk.session.getToken()');
            const res = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            const allLinks = (res.servers || []).flatMap(s => s.renew_links || []);
            const target = allLinks.find(l => !l.claimed && !processedLinks.has(l.link));

            if (!target) {
                console.log('🏁 没有更多需要续期的链接');
                break;
            }

            processedLinks.add(target.link);
            console.log(`🌐 访问广告页: ${target.link}`);
            
            await page.goto(target.link, { waitUntil: 'domcontentloaded' });
            const ok = await handleCutyChain(page);

            if (ok) {
                totalSuccess++;
                console.log('✅ 该服务器续期完成');
            } else {
                console.log('❌ 该服务器续期失败');
            }
        }

        await sendTG(totalSuccess > 0 ? `成功续期 ${totalSuccess} 个服务器` : "未完成任何续期");

    } catch (e) {
        console.error(`❌ 运行崩溃: ${e.message}`);
        await sendTG(`脚本崩溃: ${e.message}`);
    } finally {
        await browser.close();
    }
});
