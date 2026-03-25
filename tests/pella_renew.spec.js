// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 300000; // 5分钟，给批量任务留足时间

const AD_BLOCK_SCRIPT = `
(function() {
    'use strict';
    window.open = () => null; 
    setInterval(() => {
        document.querySelectorAll('div[class*="overlay"], .popunder, iframe[src*="google"]').forEach(el => el.remove());
        const selectors = ['#continue', '#getnewlink', 'a.get-link', '.btn-success', '#submit-button', '.wp2continuelink', 'p.getmylink'];
        selectors.forEach(s => {
            const btn = document.querySelector(s);
            if (btn) {
                btn.classList.remove('disabled');
                btn.style.display = 'block';
                btn.style.pointerEvents = 'auto';
            }
        });
    }, 1000);
})();
`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) return resolve();
        const body = JSON.stringify({ 
            chat_id: TG_CHAT_ID, 
            text: `🎮 Pella 批量续期\n📊 结果: ${result}\n🕐 时间: ${new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})}` 
        });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`, method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, () => resolve());
        req.on('error', () => resolve());
        req.write(body);
        req.end();
    });
}

// ── 核心穿透逻辑 ──────────────────────────────────────────
async function handleAdLink(page) {
    console.log(`  📄 当前处理页面: ${page.url()}`);
    let captured = null;
    page.on('request', req => {
        if (req.url().includes('pella.app/renew/')) captured = req.url();
    });

    for (let i = 0; i < 45; i++) {
        if (captured || page.url().includes('pella.app/renew/')) break;

        await page.evaluate(() => {
            // 针对 cuty.io / cuttlinks.com / fitnesstipz 的全家桶点击
            const clickIfExist = (s) => {
                const el = document.querySelector(s);
                if (el && !el.classList.contains('disabled')) el.click();
            };
            clickIfExist('#submit-button');
            clickIfExist('#continue');
            clickIfExist('p.getmylink');
            clickIfExist('span.wp2continuelink');
            clickIfExist('#getnewlink');
            clickIfExist('a.get-link');
            if (typeof window.get_link === 'function') window.get_link();
        }).catch(() => {});

        await sleep(2000);
        if (i % 5 === 0) console.log(`    ⏱️ 等待中... [${page.url().substring(0, 50)}]`);
    }

    if (captured) await page.goto(captured);
    await page.waitForURL(/pella\.app\/renew\//, { timeout: 10000 }).catch(() => {});
    return page.url().includes('/renew/');
}

test('Pella 自动续期 - 批量任务版', async () => {
    test.setTimeout(TIMEOUT);
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

    let processedLinks = new Set(); // 核心：记录本轮已碰过的链接

    try {
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.keyboard.press('Enter');
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.keyboard.press('Enter');
        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
        console.log('✅ 登录成功');

        let successCount = 0;
        let attemptCount = 0;

        while (attemptCount < 5) { // 最多尝试5次服务器获取
            await sleep(3000);
            const token = await page.evaluate('window.Clerk.session.getToken()');
            const res = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            const servers = res.servers || [];
            let target = null;

            for (const s of servers) {
                const links = s.renew_links || [];
                // 找出未处理过、未领取、非 tpi 的链接
                const linkObj = links.find(l => !l.claimed && !l.link.includes('tpi.li') && !processedLinks.has(l.link));
                if (linkObj) {
                    target = { link: linkObj.link, name: s.name || s.id };
                    break;
                }
            }

            if (!target) {
                console.log('🏁 本轮无更多可处理任务');
                break;
            }

            attemptCount++;
            processedLinks.add(target.link); // 标记已处理
            console.log(`🚀 任务 ${attemptCount}: [${target.name}] -> ${target.link}`);

            await page.goto(target.link, { waitUntil: 'domcontentloaded' });
            const isOk = await handleAdLink(page);
            
            if (isOk) {
                successCount++;
                console.log(`✅ 成功！`);
            } else {
                console.log(`❌ 失败。`);
            }

            console.log('🔙 返回列表...');
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
        }

        await sendTG(successCount > 0 ? `完成 ${successCount} 个服务器续期` : "任务结束（无成功）");

    } catch (e) {
        console.error(`❌ 错误: ${e.message}`);
        await sendTG(`❌ 脚本故障: ${e.message}`);
    } finally {
        await browser.close();
    }
});
