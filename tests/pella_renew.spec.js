// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const https = require('https');

const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 180000;

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
    
    const page = await context.newPage();

    try {
        // 1. 登录流程 (保持不变)
        console.log('🔑 登录 Pella...');
        await page.goto('https://www.pella.app/login', { waitUntil: 'networkidle' });
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.keyboard.press('Enter');
        await page.waitForSelector('input[name="password"]', { timeout: 15000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.keyboard.press('Enter');
        await page.waitForURL(/pella\.app\/(home|dashboard)/, { timeout: 30000 });
        console.log('✅ 登录成功');

        // 2. 核心：获取 Clerk Token 并直接与 Pella API 交互
        await sleep(3000);
        const token = await page.evaluate('window.Clerk.session.getToken()');
        
        // 3. 检查特定服务器的状态
        console.log('🔍 正在检查服务器续期状态...');
        const serversRes = await page.evaluate(async (t) => {
            const r = await fetch('https://api.pella.app/user/servers', {
                headers: { 'Authorization': `Bearer ${t}` }
            });
            return r.json();
        }, token);

        // 寻找目标服务器：bca8a69447964c2db3b2a187252420b5
        const targetId = 'bca8a69447964c2db3b2a187252420b5';
        const server = serversRes.servers.find(s => s.id === targetId);

        if (!server) {
            throw new Error(`未找到目标服务器 ${targetId}`);
        }

        const unclaimedLink = (server.renew_links || []).find(l => !l.claimed);

        if (!unclaimedLink) {
            console.log('⚠️ 服务器当前不需要续期 (可能已手动续期或时间未到)');
            return;
        }

        console.log(`🌐 发现续期链接: ${unclaimedLink.link}`);

        // 4. 🚀 暴力破解模式：直接利用 Page 监听拦截 tpi.li 的重定向
        console.log('⏳ 正在穿透 tpi.li 广告屏蔽...');
        
        let finalRenewUrl = null;
        page.on('request', request => {
            const url = request.url();
            if (url.includes('pella.app/renew/')) {
                finalRenewUrl = url;
            }
        });

        // 访问广告链接
        await page.goto(unclaimedLink.link, { waitUntil: 'domcontentloaded' });

        // 这里的 Trick：如果 tpi.li 不跳，我们强行在页面执行它的跳转函数
        for (let i = 0; i < 40; i++) {
            if (finalRenewUrl) break;

            await page.evaluate(() => {
                // 尝试直接调用 tpi.li 的内部函数
                if (typeof window.get_link === 'function') window.get_link();
                // 尝试强制触发按钮
                const btn = document.querySelector('a.btn-success, .get-link');
                if (btn) btn.click();
            }).catch(() => {});

            // 检查 URL 是否已经变了
            if (page.url().includes('pella.app/renew/')) {
                finalRenewUrl = page.url();
                break;
            }
            await sleep(2000);
            if (i % 5 === 0) console.log(`   ⏱️ 穿透中... 当前页面: ${page.url()}`);
        }

        if (finalRenewUrl) {
            console.log(`🎯 成功捕获最终地址: ${finalRenewUrl}`);
            await page.goto(finalRenewUrl, { waitUntil: 'networkidle' });
            
            // 检查页面内容是否有“Renewed”字样
            const content = await page.textContent('body');
            if (content.includes('successfully') || content.includes('Renewed') || page.url().includes('renewed=true')) {
                console.log('🎉 续期确认成功！');
                await sendTG('✅ 续期动作已完成！');
            } else {
                console.log('📊 页面已跳转，请登录 Pella 确认状态。');
                await sendTG('⚠️ 续期已跳转，请检查。');
            }
        } else {
            throw new Error('tpi.li 拒绝跳转，未能获取续期 Token');
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
