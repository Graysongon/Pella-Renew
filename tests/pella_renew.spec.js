// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000;

// ── 核心破解脚本：强制激活 cuttlinks 按钮 ──────────────────
const CUTTLINKS_BYPASS_JS = `
(function() {
    'use strict';
    // 自动移除所有覆盖层和广告弹窗
    const removeOverlays = () => {
        document.querySelectorAll('div[class*="overlay"], div[id*="pop"], iframe[src*="googlead"]').forEach(el => el.remove());
    };

    // 强制激活所有可能的“下一步”按钮
    const activateButtons = () => {
        const selectors = ['#continue', '#getnewlink', 'a.get-link', '.btn-success', '.wp2continuelink', 'button[type="submit"]'];
        selectors.forEach(s => {
            document.querySelectorAll(s).forEach(el => {
                el.style.display = 'block !important';
                el.style.visibility = 'visible !important';
                el.style.pointerEvents = 'auto !important';
                el.classList.remove('disabled');
            });
        });
    };

    window.open = () => null; // 禁用弹窗跳转
    setInterval(() => {
        removeOverlays();
        activateButtons();
    }, 1000);
})();
`;

function nowStr() {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }).replace(/\//g, '-');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function sendTG(result, extra = '') {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const body = JSON.stringify({ 
            chat_id: TG_CHAT_ID, 
            text: `🎮 Pella 续期通知\n🕐 时间: ${nowStr()}\n📊 结果: ${result}${extra ? '\n📝 ' + extra : ''}` 
        });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, () => resolve());
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

// ── 处理 CF 验证 ──────────────────────────────────────────
async function solveTurnstile(page) {
    await sleep(3000);
    const check = () => page.evaluate(() => document.querySelector('input[name="cf-turnstile-response"]')?.value?.length > 20);
    if (await check()) return true;

    try {
        const frame = await page.waitForSelector('iframe[src*="turnstile"]', { timeout: 8000 });
        if (frame) await frame.click();
    } catch (e) {}

    for (let i = 0; i < 30; i++) {
        await sleep(1000);
        if (await check()) return true;
    }
    return false;
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 自动续期', async () => {
    test.setTimeout(TIMEOUT);
    if (!PELLA_EMAIL || !PELLA_PASSWORD) throw new Error('配置缺失');

    const proxyConfig = process.env.GOST_PROXY ? { server: 'http://127.0.0.1:8080' } : undefined;

    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 800 }
    });
    
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await context.addInitScript(CUTTLINKS_BYPASS_JS);
    
    const page = await context.newPage();

    try {
        // 1. 登录
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.keyboard.press('Enter');
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.keyboard.press('Enter');
        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
        console.log('✅ 登录成功');

        // 2. 筛选 cuttlinks 续期链接
        await sleep(3000);
        const token = await page.evaluate('window.Clerk.session.getToken()');
        const res = await page.evaluate(async (t) => {
            const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
            return r.json();
        }, token);

        let renewLink = null;
        // 优先寻找包含 cuttlinks.com 的链接，如果没有则取第一个未领取的
        for (const s of (res.servers || [])) {
            const links = s.renew_links || [];
            const target = links.find(l => !l.claimed && l.link.includes('cuttlinks.com')) || links.find(l => !l.claimed);
            if (target) { renewLink = target.link; break; }
        }

        if (!renewLink) {
            console.log('⚠️ 今日无需续期或未找到匹配链接');
            return;
        }

        console.log(`🌐 访问目标链接: ${renewLink}`);

        // 📡 开启网络嗅探
        let capturedUrl = null;
        page.on('request', req => {
            if (req.url().includes('pella.app/renew/')) {
                capturedUrl = req.url();
                console.log('🎯 捕获到重定向 URL: ' + capturedUrl);
            }
        });

        await page.goto(renewLink, { waitUntil: 'domcontentloaded' });

        // 3. 处理 CF 验证
        if (await page.$('input[name="cf-turnstile-response"]')) {
            console.log('🛡️ 处理 Cloudflare...');
            await solveTurnstile(page);
        }

        // 4. 暴力循环点击逻辑 (核心适配 cuttlinks)
        console.log('⏳ 开始执行穿透点击...');
        for (let i = 0; i < 50; i++) {
            if (capturedUrl) {
                console.log('🚀 正在跳转至最终续期地址...');
                await page.goto(capturedUrl);
                break;
            }

            // 在页面执行重复点击策略
            await page.evaluate(() => {
                const btnSelectors = ['#continue', '#getnewlink', 'a.get-link', '.btn-success', '.wp2continuelink'];
                btnSelectors.forEach(s => {
                    const el = document.querySelector(s);
                    if (el && !el.classList.contains('disabled')) {
                        el.click(); // 执行点击
                    }
                });
                // 强制尝试调用潜在的跳转函数
                if (typeof window.get_link === 'function') window.get_link();
            }).catch(() => {});

            if (page.url().includes('pella.app/renew/')) break;

            await sleep(2000);
            if (i % 5 === 0) console.log(`   ⏱️ 状态确认: ${page.url()}`);
        }

        // 5. 最终验证
        await page.waitForURL(/pella\.app\/renew\//, { timeout: 15000 }).catch(() => {});
        if (page.url().includes('/renew/')) {
            console.log('🎉 恭喜，续期任务圆满完成！');
            await sendTG('✅ 续期动作成功 (cuttlinks 路径)');
        } else {
            throw new Error('未能到达目的地，当前停留在: ' + page.url());
        }

    } catch (e) {
        await page.screenshot({ path: 'error.png' });
        console.error(`❌ 错误详情: ${e.message}`);
        await sendTG(`❌ 续期异常: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
