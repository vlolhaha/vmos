import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { createMail, pollOTP } from './lib/mailtm.js';
import { solveAliyunPuzzle } from './lib/aliyun-captcha.js';
import { prepareProxy, stopProxy } from './lib/proxy.js';
import { ensureDisplay, ensureWarpService } from './lib/env-check.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// FIND BROWSER — support Chromium trên Kali
// ============================================================
function findBrowser(config) {
    // User cung cấp path qua UI
    if (config.browserPath && fs.existsSync(config.browserPath)) {
        return { path: config.browserPath, name: 'custom' };
    }
    if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) {
        return { path: process.env.BROWSER_PATH, name: 'env' };
    }

    const paths = {
        chromium: {
            linux: [
                '/usr/bin/chromium',
                '/usr/bin/chromium-browser',
                '/usr/lib/chromium/chromium',
                '/snap/bin/chromium'
            ],
            darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
            win32: [
                'C:\\Program Files\\Chromium\\Application\\chrome.exe',
                process.env.LOCALAPPDATA + '\\Chromium\\Application\\chrome.exe'
            ]
        },
        chrome: {
            linux: [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable'
            ],
            darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
            win32: [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
                process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe'
            ]
        },
        edge: {
            linux: ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable'],
            darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
            win32: [
                'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
                'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
            ]
        }
    };

    // Thứ tự ưu tiên: chromium (Linux) → chrome → edge
    const order = config.browser === 'edge' ? ['edge', 'chrome', 'chromium']
        : config.browser === 'chrome' ? ['chrome', 'chromium', 'edge']
        : config.browser === 'chromium' ? ['chromium', 'chrome', 'edge']
        : ['chromium', 'chrome', 'edge'];

    for (const name of order) {
        for (const p of paths[name][process.platform] || []) {
            if (p && fs.existsSync(p)) return { path: p, name };
        }
    }
    return null;
}

// ============================================================
// LAUNCH BROWSER
// ============================================================
async function launchBrowser(config, proxyInfo, log) {
    // Trên Linux, ensure DISPLAY trước khi launch (nếu không headless)
    if (process.platform === 'linux' && !config.headless) {
        const hasDisplay = await ensureDisplay(log);
        if (!hasDisplay) {
            throw new Error(
                'Không có DISPLAY để chạy Chromium headful.\n' +
                '  Fix: apt install -y xvfb\n' +
                '  Script đã cố tự start Xvfb nhưng fail.'
            );
        }
    }

    const found = findBrowser(config);
    if (!found) {
        throw new Error(
            'Không tìm thấy Chrome/Chromium/Edge.\n' +
            '  → Kali: apt install -y chromium\n' +
            '  → Hoặc set BROWSER_PATH trong .env'
        );
    }
    log(`🌐 Browser: ${found.name} — ${found.path}`);

    // Args cho Chromium — bao gồm flags Xvfb-compatible
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process,UserAgentClientHint',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    ];

    if (proxyInfo.proxy) {
        args.push(`--proxy-server=${proxyInfo.proxy}`);
        log(`🌐 Proxy: ${proxyInfo.proxy}`);
    }

    log('🚀 Launch Chromium...');
    const browser = await puppeteer.launch({
        executablePath: found.path,
        headless: config.headless || false,
        defaultViewport: { width: 1280, height: 900 },
        args,
        ignoreDefaultArgs: ['--enable-automation'],
        protocolTimeout: 180000,
        dumpio: false
    });
    log('✓ Chromium đã mở');
    return browser;
}

// ============================================================
// MAIN BOT — 10 BƯỚC
// ============================================================
export async function runBot(config, socket, onDone) {
    const log = (msg) => {
        const line = `[${new Date().toTimeString().slice(0,8)}] ${msg}`;
        console.log(line);
        socket.emit('log', line);
    };
    const setStep = (n, name) => {
        socket.emit('step', { n, name });
        log(`\n━━━ BƯỚC ${n}/10: ${name} ━━━`);
    };

    let browser = null;
    let proxyInfo = { method: 'none' };
    let mail = null;

    try {
        // ============================================================
        // BƯỚC 1: Proxy
        // ============================================================
        setStep(1, 'Đổi proxy/VPN');
        const useWarp = config.useWarp || process.env.WARP_ENABLED === 'true';
        if (useWarp) {
            // Đảm bảo WARP service sẵn sàng
            await ensureWarpService(log);
        }
        proxyInfo = await prepareProxy(log, { warp: useWarp });

        // ============================================================
        // BƯỚC 2: Mail.tm
        // ============================================================
        setStep(2, 'Tạo email mail.tm');
        mail = await createMail(log);

        // ============================================================
        // BƯỚC 3: Launch browser
        // ============================================================
        setStep(3, 'Mở Chromium');
        browser = await launchBrowser(config, proxyInfo, log);

        const [page] = await browser.pages();
        if (!page) throw new Error('Không có page nào được mở');

        // Anti-detect inject
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
            const origQuery = window.navigator.permissions.query;
            window.navigator.permissions.query = (params) =>
                params.name === 'notifications'
                    ? Promise.resolve({ state: Notification.permission })
                    : origQuery(params);
        });
        log('✓ Anti-detect injected');

        // ============================================================
        // INTERCEPTORS
        // ============================================================
        const imageBuffers = {};
        let initCaptcha = null;

        page.on('response', async (res) => {
            const url = res.url();
            try {
                if (/\/back\.png/.test(url)) {
                    imageBuffers.back = await res.buffer();
                    log(`📥 back.png (${imageBuffers.back.length}B)`);
                } else if (/\/shadow\.png/.test(url)) {
                    imageBuffers.shadow = await res.buffer();
                    log(`📥 shadow.png (${imageBuffers.shadow.length}B)`);
                }

                if (/captcha.*aliyuncs\.com/.test(url) && res.request().method() === 'POST') {
                    const pd = res.request().postData() || '';
                    if (pd.includes('Action=InitCaptcha')) {
                        try {
                            initCaptcha = await res.json();
                            log(`📨 InitCaptcha CertifyId=${initCaptcha.CertifyId}`);
                        } catch (e) {
                            log('⚠️ Parse InitCaptcha fail: ' + e.message);
                        }
                    }
                }
            } catch {}
        });

        // ============================================================
        // BƯỚC 4: Đăng ký
        // ============================================================
        setStep(4, 'Đăng ký tài khoản');
        log('🌐 Mở signup...');
        await page.goto('https://www.vmoscloud.com/signup', {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        });
        await sleep(4000);

        log('✍️  Điền email...');
        await page.waitForSelector(
            'input[type="email"], input[placeholder*="mail" i], input[placeholder*="Email" i]',
            { timeout: 20000 }
        );
        const emailInput = await page.$('input[type="email"], input[placeholder*="mail" i]');
        if (!emailInput) throw new Error('Không tìm thấy ô input email');
        await emailInput.type(mail.address, { delay: 40 });
        await sleep(500);

        log('🖱️ Click đăng ký...');
        await page.evaluate(() => {
            const btns = [...document.querySelectorAll('button')];
            const btn = btns.find(b => /đăng ký|sign up|get code|tiếp tục|continue|register/i.test(b.innerText));
            btn?.click();
        });

        // ============================================================
        // BƯỚC 5: Giải Captcha
        // ============================================================
        setStep(5, 'Giải Aliyun Captcha');
        log('⏳ Chờ captcha data...');
        const waitStart = Date.now();
        while (Date.now() - waitStart < 30000) {
            if (initCaptcha && imageBuffers.back && imageBuffers.shadow) break;
            await sleep(500);
        }

        if (!initCaptcha || !imageBuffers.back || !imageBuffers.shadow) {
            throw new Error(
                'Không bắt được captcha data:\n' +
                `  InitCaptcha: ${!!initCaptcha}\n` +
                `  back.png:    ${!!imageBuffers.back}\n` +
                `  shadow.png:  ${!!imageBuffers.shadow}`
            );
        }
        log('✓ Đã có captcha data');

        const capResult = await solveAliyunPuzzle(page, imageBuffers, log, {
            maxAttempts: 3,
            saveDebug: false
        });
        if (!capResult.success) throw new Error('Captcha fail sau 3 lần');
        log('✅ Captcha passed!');
        await sleep(2000);

        // ============================================================
        // BƯỚC 6: Chờ OTP signup
        // ============================================================
        setStep(6, 'Chờ OTP đăng ký');
        const signupOTP = await pollOTP(mail.token, log, { timeout: 180000 });

        // ============================================================
        // BƯỚC 7: Điền OTP
        // ============================================================
        setStep(7, 'Điền OTP đăng ký');
        log('⌨️  Điền OTP...');
        await page.waitForSelector('input[type="number"][maxlength="1"]', { timeout: 15000 });
        const otpInputs = await page.$$('input[type="number"][maxlength="1"]');
        if (otpInputs.length < 6) {
            throw new Error(`Chỉ có ${otpInputs.length} ô OTP, cần 6`);
        }

        for (let i = 0; i < 6; i++) {
            await otpInputs[i].type(signupOTP[i], { delay: 80 });
            await sleep(100);
        }

        log('🖱️ Xác nhận OTP...');
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(b =>
                /xác nhận|xác minh|confirm|verify|tiếp tục|hoàn tất/i.test(b.innerText)
            );
            btn?.click();
        });
        await sleep(8000);
        log('✓ Đã vào dashboard');

        // ============================================================
        // BƯỚC 8: Đổi mật khẩu
        // ============================================================
        setStep(8, 'Đổi mật khẩu');
        const newPassword = 'Vmos@' + Math.random().toString(36).slice(2, 10) + 'A1';
        log('🔐 Password mới: ' + newPassword);

        await page.goto('https://www.vmoscloud.com/settings', { waitUntil: 'domcontentloaded' });
        await sleep(3000);

        log('🖱️ Click "Thay đổi mật khẩu"...');
        const linkClicked = await page.evaluate(() => {
            const link = [...document.querySelectorAll('.el-link--primary')]
                .find(a => /thay đổi mật khẩu/i.test(a.innerText));
            if (!link) return false;
            link.click();
            return true;
        });
        if (!linkClicked) throw new Error('Không tìm thấy link "Thay đổi mật khẩu"');
        await sleep(2000);

        log('📨 Click "Nhận mã xác minh"...');
        const resetOTPTimeStart = Date.now();
        const verifyClicked = await page.evaluate(() => {
            const el = document.querySelector('.get-verify-code');
            if (!el) return false;
            el.click();
            return true;
        });
        if (!verifyClicked) throw new Error('Không tìm thấy nút "Nhận mã xác minh"');
        await sleep(2000);

        log('⏳ Chờ OTP đổi password...');
        const resetOTP = await pollOTP(mail.token, log, {
            timeout: 180000,
            skipCount: 1,
            since: resetOTPTimeStart
        });

        log('⌨️  Điền OTP + pass mới...');
        await page.waitForSelector('input[placeholder="Vui lòng nhập mã xác minh"]', { timeout: 10000 });
        await page.type('input[placeholder="Vui lòng nhập mã xác minh"]', resetOTP, { delay: 60 });
        await page.type('input[placeholder="Vui lòng nhập mật khẩu mới"]', newPassword, { delay: 60 });
        await sleep(500);

        log('🖱️ Xác nhận đổi password...');
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('.el-dialog__footer .el-button--primary')]
                .find(b => /chắc chắn|confirm/i.test(b.innerText));
            btn?.click();
        });
        await sleep(4000);

        const passChanged = await page.evaluate(() => {
            const dlg = document.querySelector('.el-dialog__wrapper:not([style*="display: none"])');
            return !dlg || dlg.offsetParent === null;
        });
        log(passChanged ? '✅ Đổi password OK: ' + newPassword : '⚠️ Có thể chưa đổi được password (modal vẫn mở)');

        // ============================================================
        // BƯỚC 9: Claim trial
        // ============================================================
        setStep(9, 'Claim trial cloud phone');
        await page.goto('https://www.vmoscloud.com/', { waitUntil: 'domcontentloaded' });
        await sleep(4000);

        log('🖱️ Click "Try a cloud phone"...');
        const claimed = await page.evaluate(() => {
            const btn = document.querySelector('.nb-benefit-trial button.nb-primary');
            if (!btn) return false;
            btn.click();
            return true;
        });
        if (claimed) {
            log('✓ Clicked trial button');
            await sleep(5000);
        } else {
            log('⚠️ Không thấy nút trial (có thể đã claim hoặc UI đổi)');
        }

        // ============================================================
        // BƯỚC 10: Logout
        // ============================================================
        setStep(10, 'Logout + cleanup');
        await page.goto('https://www.vmoscloud.com/settings', { waitUntil: 'domcontentloaded' });
        await sleep(2500);

        const logoutClicked = await page.evaluate(() => {
            const btn = document.querySelector('button.el-button--danger.is-plain');
            if (!btn) return false;
            btn.click();
            return true;
        });
        log(logoutClicked ? '🚪 Đã click logout' : '⚠️ Không tìm thấy nút logout');
        await sleep(3000);

        await page.evaluate(() => {
            try { localStorage.clear(); sessionStorage.clear(); } catch {}
        }).catch(() => {});

        // ============================================================
        // RESULT
        // ============================================================
        const result = {
            email: mail.address,
            password: newPassword,
            mailPassword: mail.password,
            mailToken: mail.token,
            proxyMethod: proxyInfo.method,
            proxyIp: proxyInfo.ip || null,
            timestamp: new Date().toISOString()
        };

        log('');
        log('════════════════════════════════════════════');
        log('✅ HOÀN TẤT');
        log(`📧 VMOS: ${result.email}`);
        log(`🔑 Pass: ${result.password}`);
        log(`📮 Mail: ${result.mailPassword}`);
        log(`📋 Format: ${result.email}|${result.password}|${result.mailPassword}`);
        log('════════════════════════════════════════════');

        socket.emit('result', result);

    } catch (e) {
        log('❌ LỖI: ' + e.message);
        console.error(e.stack);

        // Screenshot debug
        try {
            const pages = await browser?.pages();
            if (pages?.[0]) {
                const p = `error-${Date.now()}.png`;
                await pages[0].screenshot({ path: p, fullPage: true });
                log(`📸 Screenshot: ${p}`);
            }
        } catch {}

        socket.emit('error', e.message);
    } finally {
        try { if (browser) await browser.close(); } catch {}
        try { await stopProxy(proxyInfo, log); } catch {}
        onDone();
    }
}
