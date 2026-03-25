// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

// ================= 工具 =================
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sendTG(msg) {
    if (!TG_CHAT_ID || !TG_TOKEN) return;

    const body = JSON.stringify({
        chat_id: TG_CHAT_ID,
        text: `🎮 Pella续期\n${msg}`
    });

    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });

    req.write(body);
    req.end();
}

// ================= CF处理 =================
async function solveCF(page) {
    console.log('🛡️ 处理 CF Turnstile...');

    // 滚动到验证区域
    await page.evaluate(() => {
        const el = document.querySelector('.cf-turnstile') || document.body;
        el.scrollIntoView({ block: 'center' });
    });

    await sleep(1500);

    // 尝试点击 checkbox
    try {
        const frame = page.frameLocator('iframe[src*="cloudflare"]');
        await frame.locator('input[type="checkbox"]').click({ timeout: 5000 });
        console.log('✅ 已点击 I am not a robot');
    } catch {
        console.log('⚠️ 未找到 checkbox，尝试坐标点击');
    }

    // 等待通过
    for (let i = 0; i < 60; i++) {
        await sleep(1000);

        const ok = await page.evaluate(() => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            return input && input.value.length > 10;
        });

        if (ok) {
            console.log('✅ CF 已通过');
            return true;
        }
    }

    console.log('❌ CF失败');
    return false;
}

// ================= cuty.io流程 =================
async function handleCuty(page) {
    console.log(`🌐 cuty 页面: ${page.url()}`);

    // 点击 submit-button
    try {
        await page.waitForSelector('#submit-button', { timeout: 10000 });
        await page.click('#submit-button');
        console.log('✅ 点击 submit-button');
    } catch (e) {
        console.log('❌ submit-button 未找到');
        return false;
    }

    await sleep(3000);

    // CF 验证
    const hasCF = await page.evaluate(() =>
        !!document.querySelector('input[name="cf-turnstile-response"]')
    );

    if (hasCF) {
        const ok = await solveCF(page);
        if (!ok) return false;
    }

    // 等待倒计时
    console.log('⏳ 等待倒计时...');
    for (let i = 0; i < 60; i++) {
        await sleep(1000);

        const txt = await page.evaluate(() => {
            const el = document.querySelector('#timer');
            return el ? el.textContent.trim() : '0';
        });

        const val = parseInt(txt) || 0;

        if (val <= 0) {
            console.log('✅ 倒计时结束');
            break;
        }
    }

    // 点击 GO
    try {
        await page.click('#go-btn, .btn-success');
        console.log('✅ 点击 GO');
    } catch {
        console.log('❌ GO 按钮失败');
        return false;
    }

    await sleep(5000);

    return true;
}

// ================= 主流程 =================
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

        await sleep(2000);

        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('span.cl-internal-2iusy0');

        await page.waitForURL(/dashboard/);
        console.log('✅ 登录成功');

        // 获取 token
        const token = await page.evaluate('window.Clerk.session.getToken()');

        // ===== 执行两次 =====
        for (let round = 1; round <= 2; round++) {

            console.log(`\n🚀 第 ${round} 次续期`);

            const data = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', {
                    headers: { Authorization: `Bearer ${t}` }
                });
                return r.json();
            }, token);

            const servers = data.servers || [];

            let link = null;

            for (const s of servers) {
                const l = (s.renew_links || []).find(x => !x.claimed);
                if (l) {
                    link = l.link;
                    break;
                }
            }

            if (!link) {
                console.log('⚠️ 没有可续期');
                break;
            }

            console.log('🔗 打开:', link);
            await page.goto(link);
            await sleep(3000);

            // ===== cuty流程 =====
            const ok = await handleCuty(page);
            if (!ok) throw new Error('cuty流程失败');

            // ===== 等待回跳 =====
            await page.waitForURL(/pella\.app/, { timeout: 20000 });

            const final = page.url();
            console.log('📄 最终:', final);

            if (final.includes('/renew/')) {
                console.log('🎉 成功');
                await sendTG(`第${round}次续期成功`);
            } else {
                console.log('⚠️ 未知结果');
                await sendTG(`第${round}次未知`);
            }

            // 返回 server 页面准备下一轮
            await page.goto('https://www.pella.app/server');
            await sleep(3000);
        }

    } catch (e) {
        console.log('❌ 异常:', e.message);
        await sendTG(`❌ 脚本异常 ${e.message}`);
    }

    await browser.close();
});
