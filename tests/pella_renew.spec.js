// tests/pella_renew_cuty.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── 账号与环境配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 150000; // 提升全局超时时间至150秒，以应对多重循环和Cloudflare验证

// ── 广告拦截与DOM清洗脚本（注入环境的最底层防御）──────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';

    // ===== document-start 阶段：网络层拦截恶意脚本 =====
    const blockedScriptDomains = ['madurird.com', 'crn77.com', 'fqjiujafk.com', 'popads', 'vidoza'];
    new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.tagName === 'SCRIPT' && node.src) {
                    if (blockedScriptDomains.some(d => node.src.includes(d))) {
                        node.remove();
                        console.log('[AdBlock-Net] 彻底粉碎广告脚本注入:', node.src);
                    }
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    // ===== DOM 加载与动态演进阶段的深度清理 =====
    function init() {
        // 1. 强制切断所有新窗口弹出的可能性 (防 Pop-under)
        window.open = function() { console.log('[AdBlock-Win] 拦截 window.open 调用'); return null; };
        
        // 2. 劫持原生点击事件，阻断隐蔽的广告重定向
        document.addEventListener('click', e => {
            const a = e.target.closest('a');
            if (!a) return;
            const href = a.href || '';
            if (
                href.includes('crn77.com') ||
                href.includes('madurird.com') ||
                href.includes('popads') ||
                href.includes('avnsgames.com')
            ) {
                e.stopPropagation();
                e.preventDefault();
                console.log('[AdBlock-Event] 拦截恶意链接跳转:', href);
            }
        }, true);

        // 3. 递归式广告元素肃清机制
        function removeAds() {
            // 剥离目标按钮上的劫持事件 (关键：针对 Cuty.io 的 submit-button)
            const submitBtn = document.querySelector('#submit-button');
            if (submitBtn) {
                submitBtn.removeAttribute('onclick');
                submitBtn.removeAttribute('onmousedown');
                submitBtn.style.zIndex = '2147483647'; // 强制提升至最高层级，防止被透明 div 遮挡
                submitBtn.style.position = 'relative';
            }

            const goBtn = document.querySelector('#getnewlink') || document.querySelector('.get-link');
            if (goBtn) {
                goBtn.removeAttribute('onclick');
                goBtn.style.zIndex = '2147483647';
            }

            // 摧毁覆盖全屏的透明吸血鬼图层
            document.querySelectorAll('div[style*="z-index: 2147483647"]:not(:has(#submit-button)), .popunder, .ad-overlay').forEach(el => {
                el.remove();
                console.log('[AdBlock-DOM] 销毁透明遮挡层');
            });

            // 净化 DOM 树中的已知广告 iframe 和占位符
            document.querySelectorAll([
                'iframe[id*="netpub"]',
                'div[id*="netpub_ins"]',
                'div[id*="netpub_banner"]',
                'iframe[src*="vidoza"]',
                'iframe[style*="display: none"]'
            ].join(',')).forEach(el => el.remove());
        }

        removeAds();
        // 挂载高频突变观察者，对抗动态生成的广告
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

// ── CF Turnstile 令牌嗅探器 ─────────────────────────────────
const CF_TOKEN_LISTENER_JS = `
(function() {
    if (window.__cf_token_listener_injected__) return;
    window.__cf_token_listener_injected__ = true;
    window.__cf_turnstile_token__ = '';
    
    // 监听来自 Cloudflare iframe 的 postMessage 跨域通信
    window.addEventListener('message', function(e) {
        if (!e.origin || !e.origin.includes('cloudflare.com')) return;
        var d = e.data;
        if (!d || d.event !== 'complete' || !d.token) return;
        
        console.log('[Turnstile-Hook] 成功截获验证令牌，长度:', d.token.length);
        window.__cf_turnstile_token__ = d.token;
        
        // 主动向隐藏表单注入令牌，模拟人类完成验证
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
    console.log('[Turnstile-Hook] 探测器已潜入当前上下文');
})();
`;

// ── 核心工具与系统级交互函数 ────────────────────────────────
function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function sendTG(title, result, extra = '') {
    if (!TG_CHAT_ID || !TG_TOKEN) return;
    const lines = [
        `🤖 <b>${title}</b>`,
        `🕐 时间: ${nowStr()}`,
        `📊 状态: ${result}`,
    ];
    if (extra) lines.push(`📝 详情:\n${extra}`);
    
    const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: lines.join('\n'), parse_mode: 'HTML' });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });
    req.on('error', () => {});
    req.write(body); req.end();
}

// 通过底层 xdotool 实现真实的系统级鼠标微操，突破普通 JavaScript 点击的限制
function xdotoolClick(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    try {
        const wids = execSync('xdotool search --onlyvisible --class chrome', { timeout: 3000 })
            .toString().trim().split('\n').filter(Boolean);
        if (wids.length > 0) {
            execSync(`xdotool windowactivate ${wids[wids.length - 1]}`, { timeout: 2000, stdio: 'ignore' });
            execSync('sleep 0.2', { stdio: 'ignore' });
        }
        execSync(`xdotool mousemove ${x} ${y}`, { timeout: 2000 });
        execSync('sleep 0.15', { stdio: 'ignore' });
        execSync('xdotool click 1', { timeout: 2000 });
        console.log(`[OS-Layer] 系统级硬件鼠标点击已执行: 坐标(${x}, ${y})`);
        return true;
    } catch (e) {
        console.log(`[OS-Layer] 警告: 硬件鼠标接管失败，尝试降级处理。原因：${e.message}`);
        return false;
    }
}

// 动态计算视口在物理显示器上的绝对偏移量，确保硬件点击的精确度
async function getWindowOffset(page) {
    try {
        const wids = execSync('xdotool search --onlyvisible --class chrome', { timeout: 3000 })
            .toString().trim().split('\n').filter(Boolean);
        if (wids.length > 0) {
            const geo = execSync(`xdotool getwindowgeometry --shell ${wids[wids.length - 1]}`, { timeout: 3000 }).toString();
            const geoDict = {};
            geo.trim().split('\n').forEach(line => {
                const [k, v] = line.split('=');
                if (k && v) geoDict[k.trim()] = parseInt(v.trim());
            });
            const winX = geoDict['X'] || 0;
            const winY = geoDict['Y'] || 0;
            const info = await page.evaluate('(function(){ return { outer: window.outerHeight, inner: window.innerHeight }; })()');
            let toolbar = info.outer - info.inner;
            if (toolbar < 30 || toolbar > 200) toolbar = 87; // 默认 Chrome 顶部状态栏高度估算
            return { winX, winY, toolbar };
        }
    } catch (e) {}
    
    // 降级回退：依赖浏览器原生 API 估算
    const info = await page.evaluate('(function(){ return { screenX: window.screenX||0, screenY: window.screenY||0, outer: window.outerHeight, inner: window.innerHeight }; })()');
    let toolbar = info.outer - info.inner;
    if (toolbar < 30 || toolbar > 200) toolbar = 87;
    return { winX: info.screenX, winY: info.screenY, toolbar };
}

// ── 智能验证模块：Cloudflare Turnstile 对抗 ───────────────────
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

async function getTurnstileCoords(page) {
    return await page.evaluate(`
        (function(){
            // 策略A：寻找标准容器并计算相对偏移
            var container = document.querySelector('.cf-turnstile');
            if (container) {
                var rect = container.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                    return { click_x: Math.round(rect.x + 45), click_y: Math.round(rect.y + rect.height / 2) };
                }
            }
            // 策略B：深度扫描 iframe 矩阵，定位验证组件核心
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

async function solveTurnstile(page) {
    console.log('🛡️ [防御网络] 侦测到 Cloudflare 拦截层，初始化破译协议...');
    
    // 清除 DOM 阻碍，确保验证框完全暴露于视口
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

    // 预检：是否处于已信任状态
    if (await checkCFToken(page)) {
        console.log('✅ [防御网络] 当前会话已具有高信誉度，验证自动放行');
        return true;
    }

    // 强制视口对齐
    await page.evaluate(`
        var c = document.querySelector('.cf-turnstile') || document.querySelector('iframe[src*="cloudflare"]');
        if (c) c.scrollIntoView({ behavior: 'smooth', block: 'center' });
    `);
    await sleep(2000); // 赋予渲染管线计算坐标的缓冲时间

    const coords = await getTurnstileCoords(page);
    if (!coords) {
        console.log('❌ [防御网络] 灾难性错误：无法锁定验证模块的物理坐标');
        await page.screenshot({ path: 'debug_turnstile_no_coords.png', fullPage: true });
        return false;
    }

    // 将逻辑坐标转换为物理显示器绝对坐标
    const { winX, winY, toolbar } = await getWindowOffset(page);
    const absX = coords.click_x + winX;
    const absY = coords.click_y + winY + toolbar;
    
    console.log(`🎯 [防御网络] 锁定验证核心，执行硬件级打击: (${absX}, ${absY})`);
    xdotoolClick(absX, absY);

    // 挂起轮询机制，等待异步验证结果
    for (let i = 0; i < 60; i++) {
        await sleep(1000);
        if (await checkCFToken(page)) {
            const token = await page.evaluate('window.__cf_turnstile_token__ || ""');
            console.log(`🔓 [防御网络] 防火墙已击穿。获得有效凭据：${token.substring(0, 32)}...`);
            return true;
        }
        if (i > 0 && i % 10 === 0) console.log(`⏳ [防御网络] 等待验证结果解析，已耗时 ${i} 秒...`);
    }

    console.log('❌ [防御网络] 时间耗尽，未能突破安全验证');
    await page.screenshot({ path: 'debug_turnstile_timeout.png' });
    return false;
}

// ── 核心业务逻辑：Cuty.io 链路解析器 ──────────────────────────
async function handleCutyIo(page) {
    console.log(`🌐 [链路解析] 已切入 Cuty.io 流程：${page.url()}`);

    // 阶段1：精确定位并触发初始提交
    try {
        console.log('🔍 [链路解析] 扫描页面标识符 #submit-button...');
        const submitLocator = page.locator('#submit-button');
        await submitLocator.waitFor({ state: 'attached', timeout: 20000 });
        
        // 确保按钮位于视口中心并清除覆盖物
        await submitLocator.scrollIntoViewIfNeeded();
        await sleep(1500);
        
        console.log('🖱️ [链路解析] 强制触发第一阶段提交...');
        await submitLocator.click({ force: true, delay: 100 });
    } catch (e) {
        console.log(`⚠️ [链路解析] 警告：#submit-button 交互异常：${e.message}`);
        await page.screenshot({ path: 'debug_cuty_submit_fail.png' });
    }

    await sleep(3000); // 等待可能发生的DOM变异或重定向

    // 阶段2：应对 Cloudflare 拦截层 ("I am not a robot")
    console.log('🛡️ [链路解析] 扫描环境是否触发二次验证...');
    const hasTurnstile = await page.evaluate('!!(document.querySelector(".cf-turnstile") || document.querySelector("iframe[src*=\'cloudflare\']"))');
    if (hasTurnstile) {
        const cfOk = await solveTurnstile(page);
        if (!cfOk) throw new Error('Cuty.io 流程终止：未能突破 CF Turnstile');
    }

    // 阶段3：监控时间锁 (倒计时)
    console.log('⏳ [链路解析] 破解时间锁，初始化倒计时监控 (预计 15 秒)...');
    let timerResolved = false;
    for (let i = 0; i < 30; i++) {
        await sleep(1000);
        // 尝试探测动态变化的倒计时文本或隐藏状态
        const timerStatus = await page.evaluate(`
            (function(){
                var timerEl = document.querySelector('#timer, .timer, span[id*="time"]');
                if (!timerEl) return 'not_found';
                if (window.getComputedStyle(timerEl).display === 'none') return 'hidden';
                var text = timerEl.textContent.trim();
                var val = parseInt(text);
                if (isNaN(val)) return 'NaN';
                return val;
            })()
        `);
        
        if (timerStatus === 'hidden' || timerStatus === 0) {
            console.log('✅ [链路解析] 时间锁已解除，放行通道开启。');
            timerResolved = true;
            break;
        }
        if (typeof timerStatus === 'number') {
            if (i % 5 === 0) console.log(`   ⏱️ 时间锁剩余: ${timerStatus} 秒...`);
        }
    }
    if (!timerResolved) console.log('⚠️ [链路解析] 时间锁监控超时，尝试强制进入下一阶段。');

    // 阶段4：捕获并触发最终跳转 ("Go" / "Get Link")
    await sleep(2000); // 确保 DOM 更新完毕，Go 按钮完成渲染
    console.log('🔍 [链路解析] 搜索放行信标 (Go / Get Link)...');
    
    try {
        // Cuty.io 可能使用的几种变体选择器
        const finalBtnSelectors = [
            'button:has-text("Go")',
            'a:has-text("Go")',
            'a:has-text("Get Link")',
            'button:has-text("Get Link")',
            '#get-link',
            '.get-link'
        ].join(', ');

        const finalLocator = page.locator(finalBtnSelectors).first();
        await finalLocator.waitFor({ state: 'visible', timeout: 15000 });
        await finalLocator.scrollIntoViewIfNeeded();
        await sleep(1000);
        
        console.log('🚀 [链路解析] 激活最终跳转引擎...');
        await finalLocator.click({ force: true, delay: 200 });
        
    } catch (e) {
        console.log(`❌ [链路解析] 致命错误：未能捕获最终跳转信标：${e.message}`);
        await page.screenshot({ path: 'debug_cuty_go_fail.png' });
        throw e;
    }
    
    return true;
}

// ── 主框架：自动化任务状态机 ────────────────────────────────
test('Pella 全自动化集群维护协议', async () => {
    if (!PELLA_EMAIL || !PELLA_PASSWORD) {
        throw new Error('❌ 环境异常：丢失关键凭据 PELLA_ACCOUNT，要求格式: email,password');
    }

    // ── 代理网络配置 ─────────────────────────────────────────────
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
            console.log('🛡️ [网络层] 本地代理通道握手成功，流量已挂载至 GOST');
        } catch {
            console.log('⚠️ [网络层] 警告：代理通道无响应，系统强制降级为直连模式');
        }
    }

    // ── 浏览器引擎初始化 ───────────────────────────────────────────
    console.log('🔧 [内核] 正在唤醒 Chromium 渲染引擎...');
    const browser = await chromium.launch({
        headless: false, // 必须开启 UI 以支持 xdotool 绝对坐标打击
        proxy: proxyConfig,
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-blink-features=AutomationControlled' // 深度隐身，擦除自动化特征
        ],
    });
    
    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    // 注入底层防御体系
    await context.addInitScript(AD_BLOCK_SCRIPT);
    
    const page = await context.newPage();
    page.setDefaultTimeout(TIMEOUT);
    console.log('🚀 [内核] 渲染引擎处于最佳工作状态！');

    try {
        // ── 认证系统握手 ────────────────────────────────────
        console.log('🔑 [认证中心] 尝试建立 Pella 会话...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'domcontentloaded' });

        console.log('✏️ [认证中心] 注入账户特征签名...');
        await page.waitForSelector('#identifier-field', { timeout: 15000 });
        await page.fill('#identifier-field', PELLA_EMAIL);

        await page.click('button.cl-formButtonPrimary, span.cl-internal-2iusy0');
        await sleep(2500);

        // 针对 Clerk 系统的异步状态监控
        console.log('✏️ [认证中心] 校验加密载荷...');
        const pwdInput = page.locator('input[name="password"]');
        await pwdInput.waitFor({ state: 'attached' });
        
        // 轮询解除禁用状态
        for(let i = 0; i < 15; i++) {
            const isDisabled = await pwdInput.evaluate(el => el.disabled);
            if (!isDisabled) break;
            await sleep(1000);
        }
        
        await pwdInput.fill(PELLA_PASSWORD);
        await page.click('button.cl-formButtonPrimary, span.cl-internal-2iusy0');

        console.log('⏳ [认证中心] 校验握手协议中...');
        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 45000 });
        console.log(`✅ [认证中心] 鉴权成功！当前信标节点：${page.url()}`);

        // ── 集群状态管理与循环更新引擎 ───────────────────────────
        let activeTasks = true;
        let iteration = 0;
        let successCount = 0;

        while (activeTasks) {
            iteration++;
            console.log(`\n🔄 ================= [循环控制] 开始执行第 ${iteration} 轮更新作业 =================`);
            
            // 每次循环强制刷新状态，避免脏数据
            console.log('📡 [数据链路] 正在请求服务器矩阵集群最新拓扑图...');
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
            await sleep(3000);

            // 提取原生 Clerk Token 突破 API 限制
            console.log('🔑 [数据链路] 提取 JWT 会话凭证...');
            let token = null;
            for(let t=0; t<10; t++) {
                token = await page.evaluate('window.Clerk?.session?.getToken()');
                if (token) break;
                await sleep(1000);
            }
            if (!token) throw new Error('❌ 致命错误：JWT 凭证提取失败，鉴权链路断裂。');

            const serversRes = await page.evaluate(async (t) => {
                const res = await fetch('https://api.pella.app/user/servers', {
                    headers: { 'Authorization': `Bearer ${t}` }
                });
                return await res.json();
            }, token);

            const servers = serversRes.servers || [];
            if (servers.length === 0) {
                console.log('⚠️ [数据链路] 警告：当前账户未绑定任何服务器节点。');
                activeTasks = false;
                break;
            }

            // 扫描脏标记，定位待更新节点
            let targetServer = null;
            let targetLink = null;
            
            for (const server of servers) {
                const unclaimed = (server.renew_links || []).filter(l => l.claimed === false);
                if (unclaimed.length > 0) {
                    targetServer = server;
                    targetLink = unclaimed[0].link;
                    break;
                }
            }

            if (!targetServer || !targetLink) {
                console.log('🎉 [系统判定] 扫描完毕！所有集群节点生命周期均处于最优状态，无须续期。');
                await sendTG('Pella 维护报告', `✅ 集群维护任务圆满结束\n共成功更新: ${successCount} 个节点`, `当前时间：${nowStr()}`);
                activeTasks = false;
                break;
            }

            console.log(`📌 [作业调度] 锁定目标节点：[${targetServer.ip}] -> 注入链接: ${targetLink}`);

            // ── 执行单节点更新流 ──────────────────────────────────
            console.log(`🌐 [物理层] 切入外部解析网关...`);
            await page.goto(targetLink, { waitUntil: 'domcontentloaded' });
            await sleep(4000);
            
            const currentUrl = page.url();
            console.log(`📄 [物理层] 当前落地页域核: ${currentUrl}`);

            try {
                // 路由分发器
                if (currentUrl.includes('cuty.io')) {
                    await handleCutyIo(page);
                } else if (currentUrl.includes('fitnesstipz.com')) {
                    console.log('⚠️ [路由] 拦截到未预期的旧版中转页，系统尝试自适应降级跳过...');
                    await page.click('.getmylink, .wp2continuelink, #getnewlink').catch(() => {});
                } else {
                    console.log('⚠️ [路由] 降落至未知坐标域，激活泛型破障模式...');
                    await page.click('button:has-text("Continue"), #submit-button').catch(() => {});
                }

                // ── 结果确认与闭环验证 ──────────────────────────
                console.log('⏳ [状态机] 等待指令回调，校验更新结果...');
                try {
                    // 监听 Pella 的核心成功路由返回
                    await page.waitForURL(/pella\.app\/renew\//, { timeout: 35000 });
                    console.log(`🎉 [状态机] 节点 [${targetServer.ip}] 生命力已重置！`);
                    successCount++;
                    await sleep(3000); // 冷却时间，防止触发防刷机制
                } catch (e) {
                    const finalUrl = page.url();
                    console.log(`⚠️ [状态机] 回调校验超时，最后记录的位面：${finalUrl}`);
                    console.log(`💡 [状态机] 正在记录日志并启动下一次纠错循环...`);
                }

            } catch (err) {
                console.log(`❌ [状态机] 节点 [${targetServer.ip}] 更新作业崩溃：${err.message}`);
                await page.screenshot({ path: `debug_crash_${targetServer.ip.replace(/\./g, '_')}.png` });
                // 不抛出异常，利用 while 循环实现容错和继续下一个任务
            }
        } // 结束 While 循环

    } catch (e) {
        console.error(`💥 [系统级灾难] 框架运行时发生未捕获异常：${e.stack}`);
        await page.screenshot({ path: 'fatal_system_error.png', fullPage: true });
        await sendTG('Pella 严重故障警报', '❌ 维护作业意外终止', e.message);
        throw e;
    } finally {
        console.log('🛑 [清理进程] 释放系统资源，销毁 Chromium 实例。');
        await browser.close();
    }
});
