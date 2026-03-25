// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── 账号配置与全局参数 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 120000;
const MAX_RENEW_COUNT = 2; // 最大循环执行次数

// ── 广告拦截脚本（油猴 5.0 完整版，适配 cuty.io）────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';

    // ===== document-start 阶段：拦截广告脚本加载 =====
    const blockedScriptDomains = ['madurird.com', 'crn77.com', 'fqjiujafk.com', 'popads'];
    new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.tagName === 'SCRIPT' && node.src) {
                    if (blockedScriptDomains.some(d => node.src.includes(d))) {
                        node.remove();
                        console.log('[AdBlock] 已拦截广告脚本:', node.src);
                    }
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    // ===== DOM 加载后执行 =====
    function init() {
        // 1. 阻止所有非用户主动触发的 window.open
        const originalOpen = window.open;
        window.open = function() {
            console.log('[AdBlock] 阻止了 window.open 调用');
            return null;
        };

        // 2. 拦截已知广告链接点击
        document.addEventListener('click', e => {
            const a = e.target.closest('a');
            if (!a) return;
            const href = a.href || '';
            if (
                href.includes('crn77.com') ||
                href.includes('madurird.com') ||
                href.includes('tinyurl.com') ||
                href.includes('popads') ||
                href.includes('avnsgames.com') ||
                href.includes('fqjiujafk.com')
            ) {
                e.stopPropagation();
                e.preventDefault();
                console.log('[AdBlock] 拦截广告链接:', href);
            }
        }, true);

        // 3. 持续清理广告元素
        function removeAds() {
            // 清理影响主流程的广告覆盖层，但不破坏 #submit-button 等关键元素的绑定
            document.querySelectorAll('[onclick*="crn77"],[onclick*="madurird"]').forEach(el => el.removeAttribute('onclick'));

            // 移除广告链接与节点
            document.querySelectorAll([
                'a[href*="crn77.com"]',
                'a[href*="madurird.com"]',
                'a[href*="tinyurl.com"]',
                'a[href*="avnsgames.com"]',
                'a[href*="popads"]',
                'script[src*="madurird.com"]',
                'script[src*="fqjiujafk.com"]'
            ].join(',')).forEach(el => el.remove());

            // 移除所有 netpub 及常见的 iframe 广告元素
            document.querySelectorAll([
                'iframe[id*="netpub"]',
                'div[id*="netpub_ins"]',
                'div[id*="netpub_banner"]',
                'div[class*="eldhywa"]',
                'iframe[height="0"]',
                'iframe[style*="display: none"]',
                '.ad-container',
                '.popup-overlay'
            ].join(',')).forEach(el => {
                if(!el.src?.includes('turnstile') && !el.src?.includes('cloudflare')) {
                    el.remove();
                }
            });
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
        console.log('[TokenCapture] token length:', d.token.length);
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
    console.log('[TokenCapture] listener injected');
})();
`;

// ── 工具函数 ────────────────────────────────────────────────
function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function sendTG(result, extra = '') {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }
        const lines = [
            `🎮 Pella 续期通知`,
            `🕐 运行时间: ${nowStr()}`,
            `🖥 服务器: Pella Free`,
            `📊 续期结果: ${result}`,
        ];
        if (extra) lines.push(extra);
        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: lines.join('\n') });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            console.log(res.statusCode === 200 ? '📨 TG 推送成功' : `⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            resolve();
        });
        req.on('error', e => { console.log(`⚠️ TG 推送异常：${e.message}`); resolve(); });
        req.setTimeout(15000, () => { console.log('⚠️ TG 推送超时'); req.destroy(); resolve(); });
        req.write(body);
        req.end();
    });
}



// ── CF Turnstile 坐标获取 ────────────────────────────────────
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

// ── CF token 检测 ────────────────────────────────────────────
async function checkCFToken(page) {
    try {
        const inputOk = await page.evaluate(`
            (function(){
                var input = document.querySelector('input[name="cf-turnstile-response"]');
                return input && input.value && input.value.length > 20;
            })()
        `);
        if (inputOk) return true;
    } catch (e) {}
    try {
        const token = await page.evaluate('window.__cf_turnstile_token__ || ""');
        if (token && token.length > 20) return true;
    } catch (e) {}
    return false;
}

// ── 处理 CF Turnstile ────────────────────────────────────────
async function solveTurnstile(page) {
    await page.evaluate(`
        (function() {
            var turnstileInput = document.querySelector('input[name="cf-turnstile-response"]');
            if (!turnstileInput) return;
            var el = turnstileInput;
            for (var i = 0; i < 20; i++) {
                el = el.parentElement;
                if (!el) break;
                var style = window.getComputedStyle(el);
                if (style.overflow === 'hidden') el.style.overflow = 'visible';
                el.style.minWidth = 'max-content';
            }
        })()
    `);

    await page.evaluate(CF_TOKEN_LISTENER_JS);
    console.log('📡 开始监控 Cloudflare Turnstile Token...');

    if (await checkCFToken(page)) {
        console.log('✅ 验证已自动通过');
        return true;
    }

    await page.evaluate(`
        var c = document.querySelector('.cf-turnstile');
        if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    `);
    await sleep(1500);

    const coords = await getTurnstileCoords(page);
    if (!coords) {
        console.log('❌ 验证坐标获取失败');
        await page.screenshot({ path: 'turnstile_no_coords.png' });
        return false;
    }

    const { winX, winY, toolbar } = await getWindowOffset(page);
    const absX = coords.click_x + winX;
    const absY = coords.click_y + winY + toolbar;
    console.log('📐 坐标计算完成');
    xdotoolClick(absX, absY);

    for (let i = 0; i < 60; i++) {
        await sleep(500);
        if (await checkCFToken(page)) {
            const token = await page.evaluate('window.__cf_turnstile_token__ || ""');
            console.log(`✅ Cloudflare Turnstile 验证通过！token：${token.substring(0, 50)}...`);
            return true;
        }
    }

    console.log('❌ 人机验证超时');
    await page.screenshot({ path: 'turnstile_fail.png' });
    return false;
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 自动多轮续期', async () => {
    if (!PELLA_EMAIL || !PELLA_PASSWORD) {
        throw new Error('❌ 缺少 PELLA_ACCOUNT，格式: email,password');
    }

    // ── 代理检测 ─────────────────────────────────────────────
    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        try {
            await new Promise((resolve, reject) => {
                const req = http.request(
                    { host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 },
                    () => resolve()
                );
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.end();
            });
            proxyConfig = { server: 'http://127.0.0.1:8080' };
            console.log('🛡️ 本地代理连通，使用 GOST 转发');
        } catch {
            console.log('⚠️ 本地代理不可达，降级为直连');
        }
    }

    // ── 启动浏览器 ───────────────────────────────────────────
    console.log('🔧 启动浏览器...');
    const browser = await chromium.launch({
        headless: false,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const context = await browser.newContext();
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    console.log('🚀 浏览器就绪！');

    try {
        

        // ── 登录 pella.app ────────────────────────────────────
        console.log('🔑 打开 Pella 登录页...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'domcontentloaded' });

        console.log('✏️ 填写邮箱...');
        await page.waitForSelector('#identifier-field', { timeout: 15000 });
        await page.fill('#identifier-field', PELLA_EMAIL);

        console.log('📤 点击 Continue...');
        await page.click('span.cl-internal-2iusy0');
        await sleep(2000);

        console.log('✏️ 填写密码...');
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);

        console.log('📤 提交登录...');
        await page.click('span.cl-internal-2iusy0');

        console.log('⏳ 等待登录跳转...');
        await page.waitForURL(/pella\.app\/(home|dashboard|server)/, { timeout: 30000 });
        console.log(`✅ 登录成功！当前：${page.url()}`);

        // ── 多轮续期逻辑 (MAX_RENEW_COUNT 次) ─────────────────
        for (let round = 1; round <= MAX_RENEW_COUNT; round++) {
            console.log(`\n===========================================`);
            console.log(`🔄 开始第 [ ${round} / ${MAX_RENEW_COUNT} ] 轮续期任务`);
            console.log(`===========================================`);

            // 每次循环回到服务器列表页
            await page.goto('https://www.pella.app/server', { waitUntil: 'domcontentloaded' });
            await sleep(3000);

            // ── 等待 Clerk session 加载 ───────────────────────────
            console.log('⏳ 等待 Clerk session...');
            for (let i = 0; i < 20; i++) {
                const ready = await page.evaluate('!!(window.Clerk && window.Clerk.session)');
                if (ready) break;
                await sleep(500);
            }

            // ── 获取 JWT token ────────────────────────────────────
            console.log('🔑 获取 JWT token...');
            const token = await page.evaluate('window.Clerk.session.getToken()');
            if (!token) throw new Error(`❌ 第 ${round} 轮：无法获取 Clerk token`);
            console.log('✅ Token 获取成功');

            // ── 获取续期链接 ──────────────────────────────────────
            console.log('🔍 获取服务器续期链接...');
            const serversRes = await page.evaluate(async (t) => {
                const res = await fetch('https://api.pella.app/user/servers', {
                    headers: { 'Authorization': `Bearer ${t}` }
                });
                return await res.json();
            }, token);

            const servers = serversRes.servers || [];
            if (servers.length === 0) {
                console.log('❌ 账户下未找到任何服务器，结束任务');
                break;
            }

            let renewLink = null;
            let targetServerIp = '';
            for (const server of servers) {
                const unclaimed = (server.renew_links || []).filter(l => l.claimed === false);
                if (unclaimed.length > 0) {
                    renewLink = unclaimed[0].link;
                    targetServerIp = server.ip;
                    console.log(`✅ 找到待续期链接: ${renewLink} (归属服务器 ${targetServerIp})`);
                    break;
                }
            }

            if (!renewLink) {
                const msg = `⚠️ 第 ${round} 轮检查：所有服务器均已续期或暂无可用链接。`;
                await sendTG(msg);
                console.log(msg);
                break; // 跳出循环，结束脚本
            }

            // ── 访问广告中转链接（Cuty.io 第一关）───────────────
            console.log(`🌐 访问目标地址: ${renewLink}`);
            await page.goto(renewLink, { waitUntil: 'domcontentloaded' });
            await sleep(5000); // 预留时间让页面渲染
            console.log(`📄 当前页面: ${page.url()}`);

            // ── 点击第一层的 #submit-button ──────────────────────
            console.log('🎯 尝试精准点击 #submit-button (第一页)...');
            try {
                // 滚动到视图中心以保证能够被精准点击
                await page.evaluate(`
                    var btn = document.querySelector('#submit-button');
                    if(btn) btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
                `);
                await sleep(1500);
                await page.waitForSelector('#submit-button', { state: 'visible', timeout: 15000 });
                // 使用 Playwright 原生点击，并带有重试机制
                await page.click('#submit-button', { force: true });
                console.log('✅ 已点击 #submit-button');
                await sleep(4000); // 等待新界面加载
            } catch (e) {
                console.log(`⚠️ 第一阶段点击 #submit-button 失败/超时：${e.message}`);
                await page.screenshot({ path: `round${round}_submit_err.png` });
            }

            // ── 新的界面：验证 CF Turnstile ──────────────────────
            console.log(`📄 检查重定向后页面: ${page.url()}`);
            const hasTurnstile = await page.evaluate(
                '!!document.querySelector("input[name=\'cf-turnstile-response\']") || !!document.querySelector(".cf-turnstile")'
            );

            if (hasTurnstile) {
                console.log('🛡️ 检测到 CF Turnstile，开始处理验证...');
                const cfOk = await solveTurnstile(page);
                if (!cfOk) {
                    await sendTG(`❌ 第 ${round} 轮：CF Turnstile 验证失败`);
                    throw new Error('❌ CF Turnstile 验证失败');
                }
            }

            // ── 点击 'I am not a robot' 或相应的按钮 ───────────────
            console.log('🤖 尝试点击 "I am not a robot" ...');
            await sleep(2000); // 等待盾牌动画结束和按钮变为可点击状态
            try {
                // cuty.io 常常复用 #submit-button，或者提供一个包含特定文本的按钮
                const robotBtn = page.locator('button, a, input[type="submit"]').filter({ hasText: /i am not a robot|continue/i }).first();
                if (await robotBtn.count() > 0 && await robotBtn.isVisible()) {
                    await robotBtn.click({ force: true });
                    console.log('✅ 已点击包含 "I am not a robot" 或类似文本的按钮');
                } else {
                    // Fallback：再次点击 #submit-button
                    const submitExists = await page.locator('#submit-button').count();
                    if (submitExists > 0) {
                        await page.click('#submit-button', { force: true });
                        console.log('✅ Fallback: 已点击 #submit-button');
                    }
                }
            } catch (e) {
                console.log(`⚠️ 点击 Robot 按钮异常: ${e.message}`);
            }
            await sleep(4000); // 等待跳转进入倒计时页面

            // ── 等待倒计时结束，点击 Go ──────────────────────────
            console.log('⏳ 开始检测页面倒计时...');
            let goClicked = false;
            for (let i = 0; i < 40; i++) {
                await sleep(1000);
                
                // 尝试抓取常见计时器数值展示
                const timerVal = await page.evaluate(`
                    (function(){
                        var el = document.querySelector('#timer, .timer, span[id*="time"]');
                        return el ? parseInt(el.textContent.trim()) || null : null;
                    })()
                `);
                
                if (i % 5 === 0 && timerVal !== null) {
                    console.log(`  ⏳ 剩余 ${timerVal} 秒...`);
                }

                // 检测是否出现了 "Go" 或 "Get Link" 的按钮并且处于可见/可用状态
                const finalBtn = page.locator('button, a, .btn').filter({ hasText: /^(\s*go\s*|\s*get link\s*|\s*continue\s*)$/i }).first();
                const isFinalBtnVisible = await finalBtn.count() > 0 && await finalBtn.isVisible();
                
                // Cuty.io 倒计时结束后，有时原有的禁用按钮会移除 disabled 属性
                const isDisabled = isFinalBtnVisible ? await finalBtn.evaluate(node => node.hasAttribute('disabled')) : true;

                if (isFinalBtnVisible && !isDisabled) {
                    console.log('✅ 倒计时似乎已结束，找到可点击的最终按钮');
                    await finalBtn.evaluate(node => node.scrollIntoView({ behavior: 'smooth', block: 'center' }));
                    await sleep(1000);
                    await finalBtn.click({ force: true });
                    console.log('✅ 已点击 Go / Get Link');
                    goClicked = true;
                    break;
                }
            }

            if (!goClicked) {
                console.log('⚠️ 倒计时阶段结束未明确点击 Go，尝试强制兜底点击...');
                await page.click('#submit-button').catch(() => {});
            }

            // ── 确认到达 pella.app/renew ──────────────────────────
            console.log('⏳ 等待最终的 pella.app 回调跳转...');
            try {
                // 等待 URL 匹配 pella.app/renew/
                await page.waitForURL(/pella\.app\/renew\//, { timeout: 20000 });
            } catch {
                console.log(`⚠️ 未能在时限内检测到 renew 跳转，当前: ${page.url()}`);
            }

            const finalUrl = page.url();
            console.log(`📄 第 ${round} 轮最终地址: ${finalUrl}`);
            await page.screenshot({ path: `round${round}_final_result.png` });

            // ── 结果判断 ──────────────────────────────────────────
            if (finalUrl.includes('/renew/')) {
                console.log(`🎉 第 ${round} 轮续期成功！(IP: ${targetServerIp})`);
                await sendTG(`✅ 第 ${round} 轮续期成功！`, `🌐 节点 IP: ${targetServerIp}`);
            } else {
                console.log(`⚠️ 第 ${round} 轮续期结果未知: ${finalUrl}`);
                await sendTG(`⚠️ 第 ${round} 轮续期结果未知`, `🔗 最终URL: ${finalUrl}\n🌐 节点 IP: ${targetServerIp}`);
                // 如果出现异常页面，可能需要终止后续循环，但为保证健壮性，选择继续执行下一轮
            }
            
            console.log(`===========================================\n`);
        }

        console.log('🏁 所有续期任务执行完毕！');

    } catch (e) {
        await page.screenshot({ path: 'fatal_error.png' }).catch(() => {});
        await sendTG(`❌ 脚本全局异常：${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
