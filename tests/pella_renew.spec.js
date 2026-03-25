// tests/pella_renew.spec.js
const { test, chromium } = require('@playwright/test');
const { execSync } = require('child_process');

// 环境变量获取
const [PELLA_EMAIL, PELLA_PASSWORD] = (process.env.PELLA_ACCOUNT || ',').split(',');

// 广告屏蔽与层级置顶脚本
const AD_CLEANER = `
(function() {
    setInterval(() => {
        // 移除所有全屏透明遮罩层
        document.querySelectorAll('div[style*="z-index: 2147483647"], .popunder, .ad-overlay').forEach(el => el.remove());
        // 强制显示隐藏的按钮
        const btn = document.querySelector('#submit-button, #get-link, .btn-success');
        if (btn) {
            btn.style.setProperty('display', 'block', 'important');
            btn.style.setProperty('visibility', 'visible', 'important');
            btn.style.setProperty('z-index', '999999', 'important');
        }
    }, 500);
})();
`;

test.setTimeout(180000); // 设置测试总时长为 3 分钟

test('Pella 全自动化集群维护协议', async ({}) => {
    // 启动浏览器
    const browser = await chromium.launch({ 
        headless: false, 
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-popup-blocking'] 
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.addInitScript(AD_CLEANER);
    const page = await context.newPage();

    // 工具：等待并物理点击 (针对无法通过 JS 点击的元素)
    async function physicalClick(selector) {
        try {
            const loc = page.locator(selector).first();
            await loc.waitFor({ state: 'visible', timeout: 10000 });
            const box = await loc.boundingBox();
            if (box) {
                // 使用 xdotool 模拟物理点击，绕过所有前端干扰
                const x = Math.round(box.x + box.width / 2);
                const y = Math.round(box.y + box.height / 2 + 85); // 85 是浏览器工具栏预估高度
                execSync(`xdotool mousemove ${x} ${y} click 1`);
                return true;
            }
        } catch (e) { return false; }
    }

    try {
        // 1. 登录流程
        console.log('🔑 登录 Pella 平台...');
        await page.goto('https://www.pella.app/login');
        await page.fill('#identifier-field', PELLA_EMAIL);
        await page.click('button.cl-formButtonPrimary');
        await page.waitForSelector('input[name="password"]', { timeout: 10000 });
        await page.fill('input[name="password"]', PELLA_PASSWORD);
        await page.click('button.cl-formButtonPrimary');
        await page.waitForURL(/dashboard|home/);
        console.log('✅ 登录验证成功');

        // 2. 自动化循环
        let retryCount = 0;
        while (retryCount < 5) {
            console.log(`\n📡 [第 ${retryCount + 1} 轮作业] 正在拉取最新的节点拓扑...`);
            await page.goto('https://www.pella.app/servers', { waitUntil: 'networkidle' });
            await page.waitForTimeout(3000);

            const token = await page.evaluate(() => window.Clerk?.session?.getToken());
            const data = await page.evaluate(async (t) => {
                const r = await fetch('https://api.pella.app/user/servers', { headers: { 'Authorization': `Bearer ${t}` } });
                return r.json();
            }, token);

            const server = data.servers?.find(s => s.renew_links?.some(l => !l.claimed));
            if (!server) {
                console.log('🎉 汇报：当前所有集群节点均在线，无需维护。');
                break;
            }

            // 提取并修正链接
            let rawLink = server.renew_links.find(l => !l.claimed).link;
            let targetLink = rawLink.replace('tpi.li', 'cuty.io'); 
            console.log(`📌 锁定目标: [${server.ip}]`);
            console.log(`🚀 注入链接: ${targetLink}`);

            // 跳转到 Cuty.io
            await page.goto(targetLink);
            
            // 处理 Cuty.io 流程
            try {
                // 第一步：点击验证/提交
                await page.waitForTimeout(5000);
                const submitBtn = page.locator('#submit-button');
                if (await submitBtn.isVisible()) {
                    console.log('🖱️ 点击 Cuty 初始提交按钮...');
                    await submitBtn.click({ force: true }).catch(() => {});
                }

                // 处理可能出现的验证码 (Cloudflare)
                const turnstile = page.locator('iframe[src*="cloudflare"]');
                if (await turnstile.count() > 0) {
                    console.log('🛡️ 发现人机验证，尝试模拟点击...');
                    await physicalClick('iframe[src*="cloudflare"]');
                    await page.waitForTimeout(10000);
                }

                // 第二步：等待倒计时并点击 Go
                console.log('⏳ 等待倒计时与放行信号...');
                await page.waitForTimeout(12000);
                
                // 监听新窗口弹出（Cuty.io 经常点 Go 弹广告）
                const [popup] = await Promise.all([
                    context.waitForEvent('page', { timeout: 5000 }).catch(() => null),
                    page.click('a:has-text("Go"), button:has-text("Go"), #get-link', { force: true }).catch(() => {})
                ]);

                // 如果弹出了广告页，关掉它
                if (popup) {
                    console.log('🚫 自动屏蔽弹窗广告');
                    await popup.close();
                    // 关掉广告后可能需要再点一次真正的 Go
                    await page.click('a:has-text("Go"), #get-link', { force: true }).catch(() => {});
                }

                // 第三步：等待返回 Pella
                await page.waitForURL(/pella\.app\/renew\//, { timeout: 20000 });
                console.log('✨ 指令校验成功，节点已续期。');
            } catch (err) {
                console.log(`⚠️ 当前轮次超时或异常，正在尝试容错处理...`);
            }

            retryCount++;
        }

    } catch (e) {
        console.error(`💥 系统级灾难: ${e.message}`);
        await page.screenshot({ path: 'disaster_recovery.png' });
    } finally {
        await browser.close();
    }
});
