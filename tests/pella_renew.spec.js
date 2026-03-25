// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

// 增加总超时时间到 180 秒，应对代理网络延迟
const TIMEOUT = 180000;

// ── 广告拦截脚本（针对 Pella 续期页常见广告源）──────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    const blocked = ['madurird.com', 'crn77.com', 'fqjiujafk.com', 'popads', 'avnsgames.com'];
    new MutationObserver(mutations => {
        mutations.forEach(m => {
            m.addedNodes.forEach(node => {
                if (node.tagName === 'SCRIPT' && node.src) {
                    if (blocked.some(d => node.src.includes(d))) node.remove();
                }
            });
        });
    }).observe(document.documentElement, { childList: true, subtree: true });

    window.open = () => null; // 禁止弹出新窗口
    setInterval(() => {
        ['#continue', '#submit-button', '#getnewlink'].forEach(id => {
            document.querySelector(id)?.removeAttribute('onclick');
        });
    }, 1000);
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

// ── Cloudflare Turnstile 处理 ──────────────────────────────
async function solveTurnstile(page) {
    await sleep(2000);
    // 检查是否已经自动通过
    const isPassed = await page.evaluate(() => {
        const val = document.querySelector('input[name="cf-turnstile-response"]')?.value;
        return val && val.length > 20;
    });
    if (isPassed) return true;

    try {
        const frame = await page.waitForSelector('.cf-turnstile iframe, iframe[src*="turnstile"]', { timeout: 8000 });
        if (frame) {
            await frame.scrollIntoViewIfNeeded();
            await sleep(1000);
            await frame.click({ delay: 200 }); 
        }
    } catch (e) {
        console.log('⚠️ CF 点击未发现或失败，等待自动验证...');
    }

    for (let i = 0; i < 40; i++) {
        await sleep(1000);
        const val = await page.evaluate(() => document.querySelector('input[name="cf-turnstile-response"]')?.value);
        if (val && val.length > 20) return true;
    }
    return false;
}

// ── Fitnesstipz 中转页处理 ──────────────────────────────────
async function handleFitnesstipz(page) {
    console.log(`  📄 中转页: ${page.url()}`);
    try {
        await page.waitForSelector('p.getmylink', { timeout: 10000 });
        await page.click('p.getmylink');
    } catch (e) {}

    for (let i = 0; i < 30; i++) {
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

// ── 主测试流程 ──────────────────────────────────────────────
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

        // 1. 处理 Cloudflare
        if (await page.$('input[name="cf-turnstile-response"]')) {
            console.log('🛡️ 处理 CF 验证...');
            if (!await solveTurnstile(page)) throw new Error('CF 验证超时');
        }

        // 2. 初始 Continue 按钮
        try {
            await page.waitForSelector('#continue', { timeout: 10000 });
            await page.click('#continue', { force: true });
        } catch (e) {}

        // 3. 处理中转循环
        let loop = 0;
        while (page.url().includes('fitnesstipz.com') && loop < 5) {
            loop++;
            if (!await handleFitnesstipz(page)) throw new Error('中转处理失败');
            await sleep(3000);
        }

        // 4. 处理 tpi.li 终极关卡 (暴力破解模式)
        if (page.url().includes('tpi.li')) {
            console.log('⏳ 正在执行 tpi.li 暴力破解...');
            
            const hacked = await page.evaluate(() => {
                try {
                    // 尝试调用页面自带的跳转函数
                    if (typeof window.get_link === 'function') { window.get_link(); return 'function_called'; }
                    const btn = document.querySelector('a.btn.btn-success.btn-lg.get-link');
                    if (btn) {
                        btn.style.setProperty('display', 'block', 'important');
                        btn.classList.remove('disabled');
                        btn.click();
                        return 'forced_click';
                    }
                } catch (e) { return 'err: ' + e.message; }
                return 'not_found';
            });
            console.log(`   🛠️ 尝试状态: ${hacked}`);

            let success = (hacked === 'function_called' || hacked === 'forced_click');
            if (!success) {
                for (let i = 0; i < 40; i++) {
                    await sleep(1000);
                    const readyUrl = await page.evaluate(() => {
                        const btn = document.querySelector('a.btn.btn-success.btn-lg.get-link');
                        return (btn && btn.href && btn.href.length > 20) ? btn.href : null;
                    });
                    if (readyUrl) {
                        console.log('🎯 发现跳转链接，立即前往...');
                        await page.goto(readyUrl);
                        success = true;
                        break;
                    }
                }
            }

            if (!success) {
                // 最后的兜底：搜索页面内所有的 Pella 链接
                const backupUrl = await page.evaluate(() => {
                    const a = Array.from(document.querySelectorAll('a')).find(el => el.href.includes('pella.app/renew'));
                    return a ? a.href : null;
                });
                if (backupUrl) {
                    console.log('🔗 捕获到备用链接，强制跳转...');
                    await page.goto(backupUrl);
                    success = true;
                }
            }

            if (!success) throw new Error('tpi.li 破解失败');
        }

        // 5. 验证结果
        await page.waitForURL(/pella\.app\/renew\//, { timeout: 20000 }).catch(() => {});
        if (page.url().includes('/renew/')) {
            console.log('🎉 续期动作已完成！');
            await sendTG('✅ 续期动作成功');
        } else {
            throw new Error('未检测到最终续期页面，当前 URL: ' + page.url());
        }

    } catch (e) {
        await page.screenshot({ path: 'error.png' });
        console.error(`❌ 错误详情: ${e.message}`);
        await sendTG(`❌ 脚本异常: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
