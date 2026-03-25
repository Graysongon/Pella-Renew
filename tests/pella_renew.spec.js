// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

// ── 工具函数 ────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function nowStr() {
    return new Date().toLocaleString('zh-CN', { hour12: false });
}

// ── TG 推送 ────────────────────────────────────────────────
async function sendTG(msg) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const body = JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: `🎮 Pella续期\n${nowStr()}\n${msg}`
    });

    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
    });

    req.write(body);
    req.end();
}

// ── xdotool 点击 ───────────────────────────────────────────
function xdotoolClick(x, y) {
    try {
        execSync(`xdotool mousemove ${x} ${y}`);
        execSync(`xdotool click 1`);
    } catch {}
}

// ── 获取窗口偏移 ───────────────────────────────────────────
async function getWindowOffset(page) {
    const info = await page.evaluate(() => ({
        x: window.screenX,
        y: window.screenY,
        outer: window.outerHeight,
        inner: window.innerHeight
    }));
    return {
        winX: info.x,
        winY: info.y,
        toolbar: info.outer - info.inner
    };
}

// ── CF 处理 ────────────────────────────────────────────────
async function solveTurnstile(page) {
    console.log('🛡️ 处理 CF...');

    try {
        const frame = page.frameLocator('iframe[src*="turnstile"]');
        await frame.locator('div').first().click({ timeout: 5000 });
    } catch {}

    const box = await page.locator('iframe[src*="turnstile"]').boundingBox().catch(() => null);
    if (box) {
        await page.mouse.click(box.x + 30, box.y + box.height / 2);
    }

    for (let i = 0; i < 30; i++) {
        const ok = await page.evaluate(() => {
            const input = document.querySelector('[name="cf-turnstile-response"]');
            return input && input.value.length > 10;
        });
        if (ok) return true;
        await sleep(1000);
    }

    return false;
}

// ── fitnesstipz ────────────────────────────────────────────
async function handleFitnesstipz(page) {
    try {
        await page.click('p.getmylink');
    } catch {}

    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const done = await page.evaluate(() => {
            const el = document.querySelector('#newtimer');
            return !el || el.style.display === 'none';
        });
        if (done) break;
    }

    try { await page.click('span.wp2continuelink'); } catch {}
    await sleep(1000);

    try { await page.click('#getnewlink'); } catch {}
    await sleep(3000);
}

// ── cuty.io 处理 ───────────────────────────────────────────
async function handleCuty(page) {
    console.log('🌐 处理 cuty');

    // submit-button
    try {
        await page.waitForSelector('#submit-button', { timeout: 15000 });
        await page.click('#submit-button');
    } catch {
        const rect = await page.locator('#submit-button').boundingBox().catch(() => null);
        if (rect) {
            const { winX, winY, toolbar } = await getWindowOffset(page);
            xdotoolClick(rect.x + winX, rect.y + winY + toolbar);
        }
    }

    await sleep(3000);

    // CF
    if (await page.locator('iframe[src*="turnstile"]').count()) {
        const ok = await solveTurnstile(page);
        if (!ok) throw new Error('CF失败');
    }

    // 倒计时
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const t = await page.evaluate(() => {
            const el = document.querySelector('#timer');
            return el ? parseInt(el.textContent) : 0;
        });
        if (!t || t <= 0) break;
    }

    // GO
    try { await page.click('#go'); } catch {
        await page.evaluate(() => document.querySelector('#go')?.click());
    }

    await sleep(5000);
}

// ── 主流程 ────────────────────────────────────────────────
test('Pella 自动续期（cuty版）', async () => {

    const browser = await chromium.launch({
        headless: false,
        args: ['--no-sandbox']
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);

    try {
        // 登录
        await page.goto('https://www.pella.app/login');
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('span.cl-internal-2iusy0');
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('span.cl-internal-2iusy0');
        await page.waitForURL(/dashboard/);

        const token = await page.evaluate('window.Clerk.session.getToken()');

        // ===== 两次续期 =====
        for (let round = 1; round <= 2; round++) {

            console.log(`🚀 第${round}次`);

            const link = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', {
                    headers: { Authorization: `Bearer ${t}` }
                });
                const j = await r.json();
                for (const s of j.servers || []) {
                    const l = (s.renew_links || []).find(i => !i.claimed);
                    if (l) return l.link;
                }
                return null;
            }, token);

            if (!link) break;

            await page.goto(link);
            await sleep(3000);

            // 第一层 CF
            if (await page.locator('[name="cf-turnstile-response"]').count()) {
                const ok = await solveTurnstile(page);
                if (!ok) throw new Error('CF失败');
            }

            // continue
            try { await page.click('#continue'); } catch {}
            await sleep(3000);

            // fitnesstipz
            let loop = 0;
            while (page.url().includes('fitnesstipz.com') && loop < 5) {
                await handleFitnesstipz(page);
                loop++;
            }

            // cuty
            if (page.url().includes('cuty.io')) {
                await handleCuty(page);
            }

            // 判断
            if (page.url().includes('/renew/')) {
                await sendTG(`✅ 第${round}次成功`);
            } else {
                await sendTG(`⚠️ 第${round}次失败\n${page.url()}`);
            }

            // 返回 server
            await page.goto('https://www.pella.app/server');
            await sleep(5000);
        }

    } catch (e) {
        console.log(e);
        await sendTG('❌ 脚本异常 ' + e.message);
    } finally {
        await browser.close();
    }
});
