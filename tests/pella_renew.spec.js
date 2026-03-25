// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000;

// ── 广告拦截与防检测 ────────────────────────────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    // 屏蔽已知的广告和干扰脚本
    const blocked = ['madurird.com', 'crn77.com', 'fqjiujafk.com', 'popads', 'avnsgames.com', 'mshcdn.com'];
    new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.tagName === 'SCRIPT' && node.src) {
                    if (blocked.some(d => node.src.includes(d))) node.remove();
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    window.open = () => null; // 彻底禁止弹窗
    // 强制显示被隐藏的 Get Link 按钮
    setInterval(() => {
        const btn = document.querySelector('a.get-link, #get-link, .btn-success');
        if (btn) {
            btn.style.display = 'block !important';
            btn.style.visibility = 'visible !important';
            btn.classList.remove('disabled');
        }
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
        req.setTimeout(8000, () => resolve());
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
        if (frame) {
            await frame.click();
            console.log('👆 已手动点击 CF 验证框');
        }
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
    await context.addInitScript(AD_BLOCK_SCRIPT);
    
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

        // 2. 获取续期链接
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

        // 🎯 核心增强：开启请求监听，捕获所有重定向和跳转
        let capturedRenewUrl = null;
        page.on('request', request => {
            const url = request.url();
            if (url.includes('pella.app/renew/')) {
                capturedRenewUrl = url;
                console.log('📡 监听到目标 URL: ' + url);
            }
        });

        await page.goto(renewLink, { waitUntil: 'domcontentloaded' });

        // 3. 处理 CF 验证
        if (await page.$('input[name="cf-turnstile-response"]')) {
            console.log('🛡️ 处理 CF 验证...');
            await solveTurnstile(page);
        }

        // 4. 处理 tpi.li / fitnesstipz 混合跳转
        console.log('⏳ 监控跳转过程中...');
        
        for (let i = 0; i < 60; i++) {
            // 如果已经监听到最终 URL，直接跳转
            if (capturedRenewUrl) {
                console.log('🚀 捕获到目标，强制执行最终跳转');
                await page.goto(capturedRenewUrl);
                break;
            }

            // 暴力尝试：点击页面上所有看起来像“跳转”的元素
            await page.evaluate(() => {
                const selectors = [
                    '#continue', '#getnewlink', 'a.get-link', 
                    '.btn-success', 'p.getmylink', 'span.wp2continuelink'
                ];
                selectors.forEach(s => {
                    const el = document.querySelector(s);
                    if (el) {
                        el.classList.remove('disabled');
                        el.click();
                    }
                });
                // 尝试调用页面可能存在的跳转函数
                if (typeof window.get_link === 'function') window.get_link();
            }).catch(() => {});

            // 检查当前 URL 是否已经到达 Pella 续期页
            if (page.url().includes('pella.app/renew/')) break;
            
            await sleep(1500);
            if (i % 10 === 0) console.log(`   ⏱️ 等待中... 当前地址: ${page.url()}`);
        }

        // 5. 验证结果
        await page.waitForURL(/pella\.app\/renew\//, { timeout: 15000 }).catch(() => {});
        if (page.url().includes('/renew/')) {
            console.log('🎉 续期成功！');
            await sendTG('✅ 续期成功！');
        } else {
            throw new Error('未到达最终页面，当前 URL: ' + page.url());
        }

    } catch (e) {
        await page.screenshot({ path: 'error.png' });
        console.error(`❌ 故障: ${e.message}`);
        await sendTG(`❌ 续期失败: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
