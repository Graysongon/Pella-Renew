// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

// ── 广告拦截脚本（保留你原本的强力版本）──────────────────────
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
        setInterval(removeAds, 1000);
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
        console.log('[TokenCapture] token 获取成功');
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
            text: \`🎮 Pella 续期通知\\n🕐 时间: \${nowStr()}\\n📊 结果: \${result}\${extra ? '\\n📝 ' + extra : ''}\` 
        });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: \`/bot\${TG_TOKEN}/sendMessage\`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, () => resolve());
        req.on('error', () => resolve());
        req.setTimeout(5000, () => resolve());
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

// ── 处理 CF Turnstile（原生点击 + 监听）─────────────────────
async function solveTurnstile(page) {
    await page.evaluate(CF_TOKEN_LISTENER_JS);
    console.log('📡 开始监控 Cloudflare Turnstile...');

    // 1. 先等待看是否能自动通过（如果 IP 质量好，CF 会直接给绿勾）
    await sleep(2000);
    if (await checkCFToken(page)) {
        console.log('✅ 验证已自动通过 (免点击)');
        return true;
    }

    // 2. 尝试使用 Playwright 原生方法点击 CF iframe
    try {
        console.log('👆 尝试使用 Playwright 原生点击...');
        // 找到 CF 的 iframe 容器
        const frameElement = await page.waitForSelector('.cf-turnstile iframe, iframe[src*="turnstile"]', { timeout: 5000 });
        if (frameElement) {
            // 将元素滚动到视图中央以确保可点击
            await frameElement.scrollIntoViewIfNeeded();
            await sleep(500);
            // 模拟真实人类的点击延迟
            await frameElement.click({ delay: 150 }); 
        }
    } catch (e) {
        console.log('⚠️ 未找到可点击的 CF iframe 框，可能已被隐藏或结构改变');
    }

    // 3. 轮询检查 Token
    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        if (await checkCFToken(page)) {
            console.log(`✅ Cloudflare Turnstile 验证通过！`);
            return true;
        }
    }

    console.log('❌ CF 验证超时失败');
    await page.screenshot({ path: 'cf_turnstile_failed.png' });
    return false;
}

// ── 处理 fitnesstipz 中转页 ──────────────────────────────────
async function handleFitnesstipz(page) {
    console.log(`  📄 fitnesstipz 中转: ${page.url()}`);
    try {
        await page.waitForSelector('p.getmylink', { timeout: 10000 });
        await page.click('p.getmylink');
    } catch (e) {}

    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        const timerHidden = await page.evaluate(() => {
            const el = document.querySelector('#newtimer');
            return !el || window.getComputedStyle(el).display === 'none';
        });
        if (timerHidden) break;
    }

    try { await page.click('span.wp2continuelink'); } catch (e) {}
    await sleep(1500);

    try {
        await page.waitForSelector('#getnewlink', { timeout: 10000 });
        await page.click('#getnewlink');
        return true;
    } catch (e) {
        return false;
    }
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 自动续期', async () => {
    if (!PELLA_EMAIL || !PELLA_PASSWORD) throw new Error('缺少账号配置');

    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        proxyConfig = { server: 'http://127.0.0.1:8080' };
        console.log('🛡️ 使用 GOST 代理');
    }

    const browser = await chromium.launch({
        headless: true, // CI 环境推荐直接使用 true
        proxy: proxyConfig,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled', // 核心防检测
            '--window-size=1920,1080'
        ],
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    
    // 注入彻底擦除 webdriver 特征的脚本
    await context.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await context.addInitScript(AD_BLOCK_SCRIPT);
    
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    try {
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'domcontentloaded' });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('span.cl-internal-2iusy0');
        await page.waitForSelector('input[name="password"]');
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('span.cl-internal-2iusy0');
        
        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
        console.log('✅ 登录成功');

        for (let i = 0; i < 20; i++) {
            if (await page.evaluate('!!(window.Clerk && window.Clerk.session)')) break;
            await sleep(500);
        }

        const token = await page.evaluate('window.Clerk.session.getToken()');
        const serversRes = await page.evaluate(async (t) => {
            const res = await fetch('https://api.pella.app/user/servers', {
                headers: { 'Authorization': `Bearer ${t}` }
            });
            return res.json();
        }, token);

        let renewLink = null;
        for (const server of (serversRes.servers || [])) {
            const unclaimed = (server.renew_links || []).filter(l => !l.claimed);
            if (unclaimed.length > 0) {
                renewLink = unclaimed[0].link;
                break;
            }
        }

        if (!renewLink) {
            console.log('⚠️ 今日无需续期');
            return;
        }

        console.log(`🌐 访问广告链接: ${renewLink}`);
        await page.goto(renewLink, { waitUntil: 'domcontentloaded' });

        if (await page.$('input[name="cf-turnstile-response"]')) {
            const cfOk = await solveTurnstile(page);
            if (!cfOk) throw new Error('❌ CF Turnstile 验证失败');
        }

        try {
            await page.waitForSelector('#continue', { timeout: 10000 });
            await page.click('#continue');
            await sleep(3000);
        } catch (e) {}

        let loopCount = 0;
        while (page.url().includes('fitnesstipz.com') && loopCount < 5) {
            loopCount++;
            if (!await handleFitnesstipz(page)) throw new Error('❌ 中转页失败');
            await sleep(3000);
        }

        if (page.url().includes('tpi.li')) {
            console.log('⏳ 等待 tpi.li...');
            for (let i = 0; i < 60; i++) {
                await sleep(1000);
                const t = await page.evaluate(() => document.querySelector('#timer')?.textContent?.trim());
                if (parseInt(t || '0') <= 0) break;
            }
            await page.click('a.btn.btn-success.btn-lg.get-link');
            await sleep(3000);
        }

        await page.waitForURL(/pella\.app\/renew\//, { timeout: 15000 }).catch(() => {});
        const finalUrl = page.url();
        
        if (finalUrl.includes('/renew/')) {
            console.log('🎉 续期成功！');
            await sendTG('✅ 续期成功！');
        } else {
            console.log(`⚠️ 续期未知: ${finalUrl}`);
            await sendTG('⚠️ 续期结果未知', finalUrl);
        }

    } catch (e) {
        await page.screenshot({ path: 'error.png' }).catch(() => {});
        await sendTG(`❌ 脚本异常: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
