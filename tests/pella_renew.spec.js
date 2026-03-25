// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

// 增加总超时时间到 180 秒，防止网络波动导致超时
const TIMEOUT = 180000;

// ── 广告拦截脚本（油猴 5.0 增强版）──────────────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    const blockedScriptDomains = ['madurird.com', 'crn77.com', 'fqjiujafk.com'];
    new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.tagName === 'SCRIPT' && node.src) {
                    if (blockedScriptDomains.some(d => node.src.includes(d))) {
                        node.remove();
                    }
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    function init() {
        window.open = () => null;
        document.addEventListener('click', e => {
            const a = e.target.closest('a');
            if (!a) return;
            const href = a.href || '';
            if (['crn77.com', 'madurird.com', 'tinyurl.com', 'popads', 'avnsgames.com', 'fqjiujafk.com'].some(d => href.includes(d))) {
                e.stopPropagation();
                e.preventDefault();
            }
        }, true);

        function removeAds() {
            ['#continue', '#submit-button', '#getnewlink'].forEach(id => {
                document.querySelector(id)?.removeAttribute('onclick');
            });
            document.querySelectorAll('[onclick*="crn77"],[onclick*="madurird"]').forEach(el => el.removeAttribute('onclick'));
        }
        removeAds();
        setInterval(removeAds, 1500);
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
`;

// ── CF Turnstile token 监听脚本 ─────────────────────────────
const CF_TOKEN_LISTENER_JS = `
(function() {
    if (window.__cf_token_listener_injected__) return;
    window.__cf_token_listener_injected__ = true;
    window.__cf_turnstile_token__ = '';
    window.addEventListener('message', function(e) {
        if (!e.origin || !e.origin.includes('cloudflare.com')) return;
        var d = e.data;
        if (!d || d.event !== 'complete' || !d.token) return;
        window.__cf_turnstile_token__ = d.token;
        var inputs = document.querySelectorAll('input[name="cf-turnstile-response"]');
        for (var i = 0; i < inputs.length; i++) {
            try {
                var nativeSet = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
                nativeSet.call(inputs[i], d.token);
                inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
                inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
            } catch(err) { inputs[i].value = d.token; }
        }
    });
})();
`;

// ── 工具函数 ────────────────────────────────────────────────
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
        req.setTimeout(8000, () => resolve());
        req.write(body);
        req.end();
    });
}

// ── 检测 Token ──────────────────────────────────────────────
async function checkCFToken(page) {
    return await page.evaluate(() => {
        const input = document.querySelector('input[name="cf-turnstile-response"]');
        if (input && input.value && input.value.length > 20) return true;
        if (window.__cf_turnstile_token__ && window.__cf_turnstile_token__.length > 20) return true;
        return false;
    });
}

// ── 处理 CF Turnstile ────────────────────────────────────────
async function solveTurnstile(page) {
    await page.evaluate(CF_TOKEN_LISTENER_JS);
    await sleep(2000);
    if (await checkCFToken(page)) return true;

    try {
        const frame = await page.waitForSelector('.cf-turnstile iframe, iframe[src*="turnstile"]', { timeout: 8000 });
        if (frame) {
            await frame.scrollIntoViewIfNeeded();
            await sleep(1000);
            await frame.click({ delay: 200 }); 
        }
    } catch (e) {
        console.log('⚠️ CF 点击失败，尝试等待自动通过...');
    }

    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        if (await checkCFToken(page)) return true;
    }
    return false;
}

// ── 处理 fitnesstipz 中转页 ──────────────────────────────────
async function handleFitnesstipz(page) {
    console.log(`  📄 中转页: ${page.url()}`);
    try {
        await page.waitForSelector('p.getmylink', { timeout: 10000 });
        await page.click('p.getmylink');
    } catch (e) {}

    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const hidden = await page.evaluate(() => {
            const el = document.querySelector('#newtimer');
            return !el || window.getComputedStyle(el).display === 'none';
        });
        if (hidden) break;
    }

    try { await page.click('span.wp2continuelink', { force: true }); } catch (e) {}
    await sleep(2000);

    try {
        await page.waitForSelector('#getnewlink', { timeout: 10000 });
        await page.click('#getnewlink', { force: true });
        return true;
    } catch (e) {
        return false;
    }
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 自动续期', async () => {
    test.setTimeout(TIMEOUT);
    if (!PELLA_EMAIL || !PELLA_PASSWORD) throw new Error('配置缺失');

    let proxyConfig = process.env.GOST_PROXY ? { server: 'http://127.0.0.1:8080' } : undefined;

    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        viewport: { width: 1920, height: 1080 }
    });
    
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await context.addInitScript(AD_BLOCK_SCRIPT);
    
    const page = await context.newPage();

    try {
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('button.cl-formButtonPrimary', { timeout: 10000 }).catch(() => page.click('span.cl-internal-2iusy0'));
        
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('button.cl-formButtonPrimary', { timeout: 10000 }).catch(() => page.click('span.cl-internal-2iusy0'));
        
        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
        console.log('✅ 登录成功');

        // 获取 Token 并请求服务器列表
        await sleep(3000);
        const token = await page.evaluate('window.Clerk.session.getToken()');
        const res = await page.evaluate(async (t) => {
            const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
            return r.json();
        }, token);

        let renewLink = null;
        for (const s of (res.servers || [])) {
            const link = (s.renew_links || []).find(l => !l.claimed);
            if (link) { renewLink = link.link; break; }
        }

        if (!renewLink) {
            console.log('⚠️ 今日无需续期');
            return;
        }

        console.log(`🌐 访问续期链接: ${renewLink}`);
        await page.goto(renewLink, { waitUntil: 'domcontentloaded' });

        // 处理 CF 验证
        if (await page.$('input[name="cf-turnstile-response"]')) {
            console.log('🛡️ 检测到 CF，处理中...');
            if (!await solveTurnstile(page)) throw new Error('CF 验证失败');
            console.log('✅ CF 验证通过');
        }

        // 处理中转页逻辑
        try {
            await page.waitForSelector('#continue', { timeout: 10000 });
            await page.click('#continue', { force: true });
        } catch (e) {}

        let loop = 0;
        while (page.url().includes('fitnesstipz.com') && loop < 5) {
            loop++;
            if (!await handleFitnesstipz(page)) throw new Error('中转页处理超时');
            await sleep(3000);
        }

        // 处理 tpi.li 最终页
        if (page.url().includes('tpi.li')) {
            console.log('⏳ 正在处理 tpi.li 倒计时...');
            let clicked = false;
            for (let i = 0; i < 45; i++) {
                await sleep(1000);
                const isReady = await page.evaluate(() => {
                    const btn = document.querySelector('a.btn.btn-success.btn-lg.get-link');
                    return btn && !btn.classList.contains('disabled') && window.getComputedStyle(btn).display !== 'none';
                });
                if (isReady) {
                    await page.click('a.btn.btn-success.btn-lg.get-link', { force: true });
                    clicked = true;
                    break;
                }
            }
            if (!clicked) throw new Error('tpi.li 按钮未就绪');
        }

        await page.waitForURL(/pella\.app\/renew\//, { timeout: 20000 }).catch(() => {});
        if (page.url().includes('/renew/')) {
            console.log('🎉 续期成功！');
            await sendTG('✅ 续期成功！');
        } else {
            throw new Error('未到达最终续期页面: ' + page.url());
        }

    } catch (e) {
        await page.screenshot({ path: 'error.png' });
        console.error(`❌ 错误: ${e.message}`);
        await sendTG(`❌ 脚本异常: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
