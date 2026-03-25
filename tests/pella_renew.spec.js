// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;

// ── 广告拦截脚本（油猴 5.0 完整版，最早注入）────────────────
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
        // 阻止弹窗
        window.open = () => null;

        function removeAds() {
            // 清理影响点击的透明遮罩
            document.querySelectorAll('div[style*="z-index: 2147483647"], .popunder, .ad-overlay').forEach(el => el.remove());
            
            // 提升目标按钮层级
            const submitBtn = document.querySelector('#submit-button');
            if (submitBtn) submitBtn.style.zIndex = '9999';
            
            // 移除广告相关 onclick
            document.querySelector('#submit-button')?.removeAttribute('onclick');
            document.querySelectorAll('[onclick*="crn77"],[onclick*="madurird"]').forEach(el => el.removeAttribute('onclick'));
        }

        removeAds();
        new MutationObserver(removeAds).observe(document.documentElement, {
            childList: true,
            subtree: true
        });
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
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai', hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTG(result, extra = '') {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const lines = [
            `🎮 Pella 续期通知`,
            `🕐 运行时间: ${nowStr()}`,
            `📊 结果: ${result}`,
        ];
        if (extra) lines.push(extra);
        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: lines.join('\n') });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, () => resolve());
        req.on('error', () => resolve());
        req.setTimeout(15000, () => { req.destroy(); resolve(); });
        req.write(body); req.end();
    });
}

// ── xdotool 点击绝对坐标 ────────────────────────────────────
function xdotoolClick(x, y) {
    x = Math.round(x); y = Math.round(y);
    try {
        const wids = execSync('xdotool search --onlyvisible --class chrome', { timeout: 3000 }).toString().trim().split('\n').filter(Boolean);
        if (wids.length > 0) {
            execSync(`xdotool windowactivate ${wids[wids.length - 1]}`, { timeout: 2000, stdio: 'ignore' });
            execSync('sleep 0.2', { stdio: 'ignore' });
        }
        execSync(`xdotool mousemove ${x} ${y}`, { timeout: 2000 });
        execSync('sleep 0.15', { stdio: 'ignore' });
        execSync('xdotool click 1', { timeout: 2000 });
        console.log(`📐 xdotool 点击成功: (${x}, ${y})`);
        return true;
    } catch (e) {
        console.log(`⚠️ xdotool 点击失败：${e.message}`);
        return false;
    }
}

async function getWindowOffset(page) {
    try {
        const wids = execSync('xdotool search --onlyvisible --class chrome', { timeout: 3000 }).toString().trim().split('\n').filter(Boolean);
        if (wids.length > 0) {
            const geo = execSync(`xdotool getwindowgeometry --shell ${wids[wids.length - 1]}`, { timeout: 3000 }).toString();
            const geoDict = {};
            geo.trim().split('\n').forEach(line => {
                const [k, v] = line.split('=');
                if (k && v) geoDict[k.trim()] = parseInt(v.trim());
            });
            const info = await page.evaluate('(function(){ return { outer: window.outerHeight, inner: window.innerHeight }; })()');
            let toolbar = info.outer - info.inner;
            if (toolbar < 30 || toolbar > 200) toolbar = 87;
            return { winX: geoDict['X'] || 0, winY: geoDict['Y'] || 0, toolbar };
        }
    } catch (e) {}
    const info = await page.evaluate('(function(){ return { screenX: window.screenX||0, screenY: window.screenY||0, outer: window.outerHeight, inner: window.innerHeight }; })()');
    let toolbar = info.outer - info.inner;
    if (toolbar < 30 || toolbar > 200) toolbar = 87;
    return { winX: info.screenX, winY: info.screenY, toolbar };
}

async function getTurnstileCoords(page) {
    return await page.evaluate(`
        (function(){
            var container = document.querySelector('.cf-turnstile');
            if (container) {
                var rect = container.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return { click_x: Math.round(rect.x + 368), click_y: Math.round(rect.y + rect.height / 2) };
                }
            }
            var iframes = document.querySelectorAll('iframe');
            for (var i = 0; i < iframes.length; i++) {
                var src = iframes[i].src || '';
                if (src.includes('cloudflare') || src.includes('turnstile')) {
                    var rect = iframes[i].getBoundingClientRect();
                    if (rect.width > 0 && rect.height > 0) {
                        return { click_x: Math.round(rect.x + 30), click_y: Math.round(rect.y + rect.height / 2) };
                    }
                }
            }
            return null;
        })()
    `);
}

async function checkCFToken(page) {
    try {
        const inputOk = await page.evaluate(`(function(){ var input = document.querySelector('input[name="cf-turnstile-response"]'); return input && input.value && input.value.length > 20; })()`);
        if (inputOk) return true;
    } catch (e) {}
    try {
        const token = await page.evaluate('window.__cf_turnstile_token__ || ""');
        if (token && token.length > 20) return true;
    } catch (e) {}
    return false;
}

async function solveTurnstile(page) {
    await page.evaluate(CF_TOKEN_LISTENER_JS);
    console.log('📡 开始监控 Cloudflare Turnstile Token...');

    if (await checkCFToken(page)) {
        console.log('✅ 验证已自动通过');
        return true;
    }

    await page.evaluate(`
        var c = document.querySelector('.cf-turnstile') || document.querySelector('iframe[src*="cloudflare"]');
        if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    `);
    await sleep(2000);

    const coords = await getTurnstileCoords(page);
    if (!coords) {
        console.log('❌ 验证坐标获取失败');
        return false;
    }

    const { winX, winY, toolbar } = await getWindowOffset(page);
    const absX = coords.click_x + winX;
    const absY = coords.click_y + winY + toolbar;
    xdotoolClick(absX, absY);

    for (let i = 0; i < 40; i++) {
        await sleep(500);
        if (await checkCFToken(page)) {
            console.log(`✅ Cloudflare Turnstile 验证通过！`);
            return true;
        }
    }
    console.log('❌ 人机验证超时');
    return false;
}

// ── Cuty.io 核心处理逻辑 ────────────────────────────────────
async function handleCuty(page) {
    console.log(`🌐 正在处理 Cuty.io: ${page.url()}`);
    try {
        // 1. 点击初始的 submit-button
        console.log('🔍 查找并点击 submit-button...');
        const submitBtn = page.locator('#submit-button');
        await submitBtn.waitFor({ state: 'visible', timeout: 15000 });
        await sleep(1500); // 留出时间让遮罩消失
        await submitBtn.click({ force: true });
        console.log('✅ 已点击 submit-button，等待页面刷新...');

        // 2. 处理跳转后的验证 (CF Turnstile & I am not a robot)
        await sleep(4000);
        
        // 检查是否有明确的 "I am not a robot" 按钮
        try {
            const robotBtn = page.locator('button:has-text("I am not a robot"), a:has-text("I am not a robot"), #robot-btn').first();
            if (await robotBtn.isVisible({ timeout: 3000 })) {
                await robotBtn.click();
                console.log('✅ 已点击 "I am not a robot" 按钮');
                await sleep(2000);
            }
        } catch (e) {}

        // 处理 CF Turnstile
        const hasTurnstile = await page.evaluate('!!(document.querySelector(".cf-turnstile") || document.querySelector("iframe[src*=\'cloudflare\']"))');
        if (hasTurnstile) {
            console.log('🛡️ 检测到 CF Turnstile，执行 xdotool 验证...');
            const cfOk = await solveTurnstile(page);
            if (!cfOk) throw new Error('Turnstile 验证失败');
        }

        // 3. 等待倒计时
        console.log('⏳ 等待 12 秒倒计时...');
        await sleep(12000); 

        // 4. 点击最终的 GO/Get Link 按钮
        console.log('🔍 查找 GO 按钮...');
        const goBtn = page.locator('a:has-text("Get Link"), button:has-text("Go"), a:has-text("GO"), #submit-button').last();
        await goBtn.waitFor({ state: 'visible', timeout: 15000 });
        await goBtn.click({ force: true });
        console.log('✅ 已点击 GO 按钮');

        return true;
    } catch (e) {
        console.log(`❌ Cuty.io 处理失败: ${e.message}`);
        await page.screenshot({ path: 'cuty_fail.png' });
        return false;
    }
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 自动循环续期', async () => {
    if (!PELLA_EMAIL || !PELLA_PASSWORD) throw new Error('❌ 缺少账号配置');

    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) proxyConfig = { server: 'http://127.0.0.1:8080' };

    const browser = await chromium.launch({ headless: false, proxy: proxyConfig, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);

    try {
        // ── 1. 登录 Pella ─────────────────────────────────────────
        console.log('🔑 打开 Pella 登录页...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'domcontentloaded' });

        await page.waitForSelector('#identifier-field', { timeout: 15000 });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('button.cl-formButtonPrimary, span.cl-internal-2iusy0');
        await sleep(2000);

        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.waitForFunction(() => !document.querySelector('input[name="password"]').disabled);
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('button.cl-formButtonPrimary, span.cl-internal-2iusy0');

        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
        console.log('✅ 登录成功！');

        // ── 2. 任务循环处理 ───────────────────────────────────────
        let hasTasks = true;
        let taskCounter = 0;

        while (hasTasks) {
            taskCounter++;
            console.log(`\n🔄 正在检索第 ${taskCounter} 个任务...`);
            
            // 返回服务器列表页面获取最新状态
            await page.goto('https://www.pella.app/servers', { waitUntil: 'domcontentloaded' });
            
            // 等待 Token 就绪
            for (let i = 0; i < 20; i++) {
                if (await page.evaluate('!!(window.Clerk && window.Clerk.session)')) break;
                await sleep(500);
            }
            const token = await page.evaluate('window.Clerk.session.getToken()');
            if (!token) throw new Error('❌ 无法获取 Clerk token');

            // 请求 API 检查是否有未续期的节点
            const serversRes = await page.evaluate(async (t) => {
                const res = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return await res.json();
            }, token);

            const servers = serversRes.servers || [];
            let renewLink = null;
            let currentIp = '';

            for (const server of servers) {
                const unclaimed = (server.renew_links || []).filter(l => l.claimed === false);
                if (unclaimed.length > 0) {
                    renewLink = unclaimed[0].link;
                    currentIp = server.ip;
                    break;
                }
            }

            if (!renewLink) {
                console.log('🎉 所有服务器已成功续期！任务结束。');
                await sendTG('✅ 所有服务器已完成续期');
                hasTasks = false;
                break;
            }

            console.log(`🔗 开始处理服务器 [${currentIp}] 的链接: ${renewLink}`);
            
            // 跳转至 Cuty 链接
            await page.goto(renewLink, { waitUntil: 'domcontentloaded' });
            await sleep(3000);

            // 处理 Cuty 页面
            if (page.url().includes('cuty.io')) {
                const cutyOk = await handleCuty(page);
                if (!cutyOk) {
                    console.log(`⚠️ Cuty 处理异常，跳过当前节点: ${currentIp}`);
                    continue; // 失败则继续下一个循环，重新拉取 API
                }
            } else {
                console.log('⚠️ 链接非 Cuty.io，尝试点击默认 Continue');
                await page.click('#submit-button, #continue').catch(() => {});
            }

            // 验证是否成功跳回 Pella 并显示成功
            console.log('⏳ 等待验证结果返回 Pella...');
            try {
                await page.waitForURL(/pella\.app\/renew\//, { timeout: 25000 });
                console.log(`✅ 节点 [${currentIp}] 续期触发成功！准备执行下一个...`);
                await sleep(2000);
            } catch (e) {
                console.log(`⚠️ 未能在预期时间内检测到跳转回 Pella，当前URL: ${page.url()}`);
            }
        }

    } catch (e) {
        await page.screenshot({ path: 'fatal_error.png' }).catch(() => {});
        await sendTG(`❌ 脚本崩溃：${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
