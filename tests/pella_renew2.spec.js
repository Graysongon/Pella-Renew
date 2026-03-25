// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

// ── 广告拦截脚本（注入增强版） ────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    // 拦截广告域名
    const blockedDomains = ['madurird.com', 'crn77.com', 'fqjiujafk.com', 'popads', 'avnsgames.com'];
    
    // 1. 拦截脚本加载
    new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.tagName === 'SCRIPT' && node.src) {
                    if (blockedDomains.some(d => node.src.includes(d))) {
                        node.remove();
                    }
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    function cleanUI() {
        // 移除 window.open 劫持
        window.open = function() { return null; };
        
        // 清理所有带广告链接的 onclick 和元素
        const selectors = [
            '#continue', '#submit-button', '#getnewlink', '.wp2continuelink', 'a.get-link'
        ];
        selectors.forEach(sel => {
            const el = document.querySelector(sel);
            if (el) {
                el.removeAttribute('onclick');
                el.style.zIndex = "2147483647"; // 确保元素在最上层
                el.style.position = "relative";
            }
        });

        // 强力移除遮罩层（除了 CF 验证码）
        document.querySelectorAll('div[style*="fixed"], div[style*="absolute"]').forEach(el => {
            if (!el.querySelector('.cf-turnstile') && !el.id.includes('clerk')) {
                const zIndex = parseInt(window.getComputedStyle(el).zIndex);
                if (zIndex > 100) el.remove();
            }
        });
    }

    setInterval(cleanUI, 1000);
})();
`;

// ── CF Token 监听与自动注入 ─────────────────────────────
const CF_TOKEN_LISTENER_JS = `
(function() {
    window.__cf_turnstile_token__ = '';
    window.addEventListener('message', function(e) {
        if (e.data && e.data.event === 'complete' && e.data.token) {
            window.__cf_turnstile_token__ = e.data.token;
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            if (input) {
                input.value = e.data.token;
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    });
})();
`;

// ── 工具函数 ────────────────────────────────────────────────
function nowStr() {
    return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

async function sendTG(result, extra = '') {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const body = JSON.stringify({ 
        chat_id: TG_CHAT_ID, 
        text: `🎮 Pella 续期通知\n🕐 时间: ${nowStr()}\n📊 结果: ${result}${extra ? '\n📝 ' + extra : ''}` 
    });
    try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body
        });
    } catch (e) { console.error('TG 推送失败', e); }
}

// ── 处理 CF Turnstile（增强注入版） ──────────────────────────
async function solveTurnstile(page) {
    await page.evaluate(CF_TOKEN_LISTENER_JS);
    
    // 尝试在 iFrame 中寻找并点击（模拟人工触发）
    try {
        const frame = page.frames().find(f => f.url().includes('cloudflare.com/cdn-cgi/challenge/'));
        if (frame) {
            console.log('🎯 尝试点击 Turnstile 选框...');
            await frame.click('input[type="checkbox"]', { timeout: 3000 }).catch(() => {});
        }
    } catch (e) {}

    // 轮询检查 Token 是否生成
    for (let i = 0; i < 60; i++) {
        const token = await page.evaluate(() => {
            const input = document.querySelector('input[name="cf-turnstile-response"]');
            return (input && input.value.length > 20) ? input.value : window.__cf_turnstile_token__;
        });

        if (token && token.length > 20) {
            console.log('✅ CF Token 获取成功');
            return true;
        }
        await page.waitForTimeout(500);
    }
    return false;
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 自动续期', async () => {
    if (!PELLA_EMAIL || !PELLA_PASSWORD) throw new Error('缺少账号配置');

    const browser = await chromium.launch({
        headless: true, // GitHub Actions 建议使用 True
        args: [
            '--no-sandbox', 
            '--disable-blink-features=AutomationControlled' // 极其重要：隐藏自动化特征
        ]
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    try {
        // 1. 登录流程
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('button[type="submit"]', { delay: 100 });
        await page.waitForSelector('input[name="password"]');
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('button[type="submit"]', { delay: 100 });
        
        await page.waitForURL(/pella\.app\/(home|dashboard)/);
        console.log('✅ 登录成功');

        // 2. 获取 JWT & 续期链接
        await page.waitForFunction(() => !!(window.Clerk && window.Clerk.session));
        const jwtToken = await page.evaluate('window.Clerk.session.getToken()');
        
        const serversRes = await page.evaluate(async (t) => {
            const res = await fetch('https://api.pella.app/user/servers', {
                headers: { 'Authorization': `Bearer ${t}` }
            });
            return res.json();
        }, jwtToken);

        const server = (serversRes.servers || []).find(s => s.renew_links?.some(l => !l.claimed));
        if (!server) {
            console.log('⚠️ 今日无需续期');
            return;
        }
        const renewLink = server.renew_links.find(l => !l.claimed).link;

        // 3. 处理广告链
        console.log(`🌐 访问续期页: ${renewLink}`);
        await page.goto(renewLink, { waitUntil: 'domcontentloaded' });

        // 处理 CF Turnstile
        const hasCF = await page.$('input[name="cf-turnstile-response"]').catch(() => null);
        if (hasCF) {
            console.log('🛡️ 检测到 Cloudflare，正在破解...');
            const cfOk = await solveTurnstile(page);
            if (!cfOk) throw new Error('CF 验证码突破失败');
        }

        // 点击第一页 Continue
        await page.click('#continue', { force: true }).catch(() => {});
        await page.waitForTimeout(2000);

        // 处理 fitnesstipz 中转
        if (page.url().includes('fitnesstipz')) {
            console.log('🔄 处理 fitnesstipz 中转...');
            await page.click('p.getmylink', { force: true }).catch(() => {});
            // 等待倒计时消失
            await page.waitForSelector('#newtimer', { state: 'hidden', timeout: 30000 }).catch(() => {});
            await page.click('#getnewlink', { force: true });
        }

        // 4. 最终 Get Link
        console.log('⏳ 等待 tpi.li 倒计时...');
        await page.waitForSelector('a.get-link:not(.disabled)', { timeout: 35000 }).catch(() => {});
        await page.click('a.get-link', { force: true });

        // 5. 验证结果
        await page.waitForTimeout(5000);
        const finalUrl = page.url();
        if (finalUrl.includes('/renew/')) {
            console.log('🎉 续期成功！');
            await sendTG('✅ 续期成功');
        } else {
            console.log('⚠️ 续期结果不明', finalUrl);
            await page.screenshot({ path: 'unknown_result.png' });
            await sendTG('⚠️ 续期状态未知', `URL: ${finalUrl}`);
        }

    } catch (e) {
        console.error(`❌ 脚本崩溃: ${e.message}`);
        await page.screenshot({ path: 'error.png' });
        await sendTG(`❌ 脚本异常`, e.message);
        throw e;
    } finally {
        await browser.close();
    }
});
