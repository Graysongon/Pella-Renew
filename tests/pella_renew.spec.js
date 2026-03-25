// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000;

// ── 针对 cuttlinks 的专项破解注入脚本 ──────────────────────
const BYPASS_JS = `
(function() {
    'use strict';
    // 移除所有可能的广告遮罩层
    setInterval(() => {
        const ads = document.querySelectorAll('div[class*="overlay"], iframe[src*="google"], .popunder, .pop-ads');
        ads.forEach(el => el.remove());
        
        // 强制激活按钮
        const selectors = ['#continue', '#getnewlink', 'a.get-link', '.btn-success', '.wp2continuelink', 'button#btn-main'];
        selectors.forEach(s => {
            const btn = document.querySelector(s);
            if (btn) {
                btn.classList.remove('disabled');
                btn.style.display = 'block';
                btn.style.pointerEvents = 'auto';
            }
        });
    }, 1000);
    window.open = () => null; // 禁止弹窗跳转
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
        const frame = await page.waitForSelector('iframe[src*="turnstile"]', { timeout: 5000 });
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
    });
    
    await context.addInitScript(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
    await context.addInitScript(BYPASS_JS);
    
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

        // 2. 筛选链接：彻底删除 tpi.li，寻找 cuttlinks
        await sleep(3000);
        const token = await page.evaluate('window.Clerk.session.getToken()');
        const res = await page.evaluate(async (t) => {
            const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
            return r.json();
        }, token);

        let renewLink = null;
        let serverId = null;

        for (const s of (res.servers || [])) {
            const links = s.renew_links || [];
            // 过滤掉所有包含 tpi.li 的链接
            const safeLinks = links.filter(l => !l.claimed && !l.link.includes('tpi.li'));
            
            // 优先寻找 cuttlinks.com
            const target = safeLinks.find(l => l.link.includes('cuttlinks.com')) || safeLinks[0];
            
            if (target) {
                renewLink = target.link;
                serverId = s.id;
                break;
            }
        }

        if (!renewLink) {
            console.log('⚠️ 未找到可用且安全的续期链接 (已排除 tpi.li)');
            return;
        }

        console.log(`🌐 目标服务器 ID: ${serverId}`);
        console.log(`🌐 访问安全续期链接: ${renewLink}`);

        // 📡 开启网络嗅探
        let capturedUrl = null;
        page.on('request', req => {
            if (req.url().includes('pella.app/renew/')) {
                capturedUrl = req.url();
                console.log('🎯 捕获到目标跳转: ' + capturedUrl);
            }
        });

        await page.goto(renewLink, { waitUntil: 'domcontentloaded' });

        // 3. 处理 CF 验证
        if (await page.$('input[name="cf-turnstile-response"]')) {
            console.log('🛡️ 处理 Cloudflare...');
            await solveTurnstile(page);
        }

        // 4. 暴力点击逻辑
        console.log('⏳ 执行穿透点击...');
        for (let i = 0; i < 45; i++) {
            if (capturedUrl) {
                await page.goto(capturedUrl);
                break;
            }

            await page.evaluate(() => {
                const btns = ['#continue', '#getnewlink', 'a.get-link', '.btn-success', '.wp2continuelink'];
                btns.forEach(s => {
                    const el = document.querySelector(s);
                    if (el && !el.classList.contains('disabled')) el.click();
                });
                if (typeof window.get_link === 'function') window.get_link();
            }).catch(() => {});

            if (page.url().includes('pella.app/renew/')) break;
            
            await sleep(2000);
            if (i % 5 === 0) console.log(`   ⏱️ 当前位置: ${page.url()}`);
        }

        // 5. 验证结果
        await page.waitForURL(/pella\.app\/renew\//, { timeout: 15000 }).catch(() => {});
        if (page.url().includes('/renew/')) {
            console.log('🎉 续期完成！');
            await sendTG('✅ 续期动作成功 (已避开 tpi.li)');
        } else {
            throw new Error('未能到达续期页，卡在: ' + page.url());
        }

    } catch (e) {
        await page.screenshot({ path: 'error.png' });
        console.error(`❌ 错误: ${e.message}`);
        await sendTG(`❌ 续期失败: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
