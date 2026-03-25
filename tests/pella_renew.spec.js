// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');
const http = require('http');
const { execSync } = require('child_process');

// ── 账号配置 ────────────────────────────────────────────────
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000; // 增加超时时间以应对多个续期

// ── 广告拦截与 cuty.io 增强脚本 ─────────────────────────────
const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    window.open = () => null; // 封杀所有弹窗跳转
    
    // 持续清理遮罩和激活按钮
    setInterval(() => {
        // 移除广告遮罩
        document.querySelectorAll('div[class*="overlay"], .popunder, iframe[src*="google"]').forEach(el => el.remove());
        
        // 强制激活 cuty.io 和 pella 的潜在按钮
        const selectors = ['#continue', '#getnewlink', 'a.get-link', '.btn-success', '#submit-button', '.wp2continuelink'];
        selectors.forEach(s => {
            const btn = document.querySelector(s);
            if (btn) {
                btn.classList.remove('disabled');
                btn.style.display = 'block';
                btn.style.pointerEvents = 'auto';
                btn.style.visibility = 'visible';
            }
        });
    }, 1000);
})();
`;

// ── 工具函数 ────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const body = JSON.stringify({ 
            chat_id: TG_CHAT_ID, 
            text: `🎮 Pella 批量续期通知\n📊 结果: ${result}\n🕐 时间: ${new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})}` 
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

// ── 处理 cuty.io 逻辑 ───────────────────────────────────────
async function handleCutyIO(page) {
    console.log(`  📄 处理 cuty.io 页面: ${page.url()}`);
    
    // 监听是否直接触发了 Pella 的续期请求
    let captured = null;
    const listener = req => {
        if (req.url().includes('pella.app/renew/')) captured = req.url();
    };
    page.on('request', listener);

    try {
        // 第一步：寻找并点击第一个 Continue/Verify 按钮
        for (let i = 0; i < 30; i++) {
            if (captured) break;
            await page.evaluate(() => {
                const btn = document.querySelector('#submit-button') || document.querySelector('#continue');
                if (btn && !btn.disabled) btn.click();
            }).catch(() => {});
            
            await sleep(2000);
            if (i % 5 === 0) console.log(`    ⏱️ 等待第一步跳转... ${page.url()}`);
            if (page.url().includes('pella.app/renew/')) break;
        }

        // 第二步：如果是中转页，等待并点击 Get Link
        if (!page.url().includes('pella.app/renew/') && !captured) {
            console.log('  ⏳ 等待倒计时与 Get Link 按钮...');
            await sleep(6000); // 避开 cuty 的初始倒计时
            await page.evaluate(() => {
                const getLink = document.querySelector('#getnewlink') || document.querySelector('a.get-link');
                if (getLink) getLink.click();
            }).catch(() => {});
        }

        if (captured) await page.goto(captured);
        
        await page.waitForURL(/pella\.app\/renew\//, { timeout: 15000 }).catch(() => {});
        page.off('request', listener);
        return page.url().includes('/renew/');
    } catch (e) {
        console.log(`  ❌ cuty.io 处理异常: ${e.message}`);
        page.off('request', listener);
        return false;
    }
}

// ── 主测试 ──────────────────────────────────────────────────
test('Pella 自动续期 - 批量任务版', async () => {
    const proxyConfig = process.env.GOST_PROXY ? { server: 'http://127.0.0.1:8080' } : undefined;

    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });

    const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });
    
    await context.addInitScript(AD_BLOCK_SCRIPT);
    const page = await context.newPage();

    try {
        // 1. 登录 Pella
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.keyboard.press('Enter');
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.keyboard.press('Enter');
        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
        console.log('✅ 登录成功');

        // 2. 循环处理所有需要续期的服务器
        let successCount = 0;
        let totalProcessed = 0;

        while (true) {
            await sleep(3000);
            const token = await page.evaluate('window.Clerk.session.getToken()');
            const res = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            const servers = res.servers || [];
            let targetLink = null;
            let targetServerName = '';

            // 筛选：跳过 tpi.li，优先 cuty.io
            for (const s of servers) {
                const links = s.renew_links || [];
                const valid = links.find(l => !l.claimed && !l.link.includes('tpi.li'));
                if (valid) {
                    // 找到一个还没续期的服务器
                    targetLink = valid.link;
                    targetServerName = s.name || s.id;
                    break;
                }
            }

            if (!targetLink) {
                console.log('🏁 所有符合条件的服务器已处理完毕');
                break;
            }

            totalProcessed++;
            console.log(`🚀 开始处理第 ${totalProcessed} 个任务 [${targetServerName}]`);
            console.log(`🌐 访问链接: ${targetLink}`);

            await page.goto(targetLink, { waitUntil: 'domcontentloaded' });
            
            const isOk = await handleCutyIO(page);
            if (isOk) {
                console.log(`✅ 服务器 ${targetServerName} 续期成功！`);
                successCount++;
            } else {
                console.log(`❌ 服务器 ${targetServerName} 续期失败`);
            }

            // 返回服务器列表页，准备处理下一个
            console.log('🔙 返回服务器列表...');
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
        }

        // 3. 结果汇总
        const resultMsg = successCount > 0 ? `成功 ${successCount}/${totalProcessed}` : "未发现可用任务或全部失败";
        await sendTG(resultMsg);

    } catch (e) {
        await page.screenshot({ path: 'error.png' }).catch(() => {});
        console.error(`❌ 全局故障: ${e.message}`);
        await sendTG(`❌ 脚本崩溃: ${e.message}`);
        throw e;
    } finally {
        await browser.close();
    }
});
