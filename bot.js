import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { createMail, pollOTP } from './lib/mailtm.js';
import { solveAliyunPuzzle } from './lib/aliyun-captcha.js';
import { prepareProxy, stopProxy } from './lib/proxy.js';
import { ensureDisplay, ensureWarpService } from './lib/env-check.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// TÌM BROWSER (Hỗ trợ Chromium trên Kali)
// ============================================================
function findBrowser(config) {
    if (config.browserPath && fs.existsSync(config.browserPath)) {
        return { path: config.browserPath, name: 'custom' };
    }
    if (process.env.BROWSER_PATH && fs.existsSync(process.env.BROWSER_PATH)) {
        return { path: process.env.BROWSER_PATH, name: 'env' };
    }

    const paths = {
        chromium: {
            linux: ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
            darwin: ['/Applications/Chromium.app/Contents/MacOS/Chromium'],
            win32: ['C:\\Program Files\\Chromium\\Application\\chrome.exe']
        },
        chrome: {
            linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'],
            darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
            win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
        }
    };

    const order = ['chromium', 'chrome'];
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
    if (process.platform === 'linux' && !config.headless) {
        const hasDisplay = await ensureDisplay(log);
        if (!hasDisplay) throw new Error('Không có DISPLAY để chạy Chromium headful. Chạy: apt install -y xvfb');
    }

    const found = findBrowser(config);
    if (!found) throw new Error('Không tìm thấy Chromium/Chrome. Cài đặt: apt install -y chromium');

    log(`🌐 Browser: ${found.name} — ${found.path}`);

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
        protocolTimeout: 180000
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
        if (useWarp) await ensureWarpService(log);
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
        });
        log('✓ Anti-detect injected');

        // ============================================================
        // INTERCEPTORS (Bắt Captcha)
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
                        } catch (e) {}
                    }
                }
            } catch {}
        });

        // ============================================================
        // BƯỚC 4: Đăng ký (Popup Login)
        // ============================================================
        setStep(4, 'Đăng ký tài khoản (Popup)');
        log('🌐 Mở trang chủ VMOS...');
        await page.goto('https://cloud.vmoscloud.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await sleep(5000);

        // Kiểm tra popup đã tự mở chưa
        log('🔎 Kiểm tra popup login...');
        const popupAlreadyOpen = await page.evaluate(() => {
            const dlg = document.querySelector('#login-dialog');
            return !!(dlg && dlg.offsetParent !== null);
        });

        if (!popupAlreadyOpen) {
            log('🖱️ Popup chưa mở, tìm nút Sign in...');
            const clicked = await page.evaluate(() => {
                const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
                for (const el of candidates) {
                    if (el.offsetParent === null) continue;
                    const text = (el.innerText || el.textContent || '').trim();
                    if (/^(sign|log)\s*in$|^đăng\s*nhập$|^login$/i.test(text)) {
                        el.click();
                        return text;
                    }
                }
                return null;
            });
            log(clicked ? `✓ Clicked: "${clicked}"` : '⚠️ Không thấy nút Sign in');
            await sleep(3000);
        } else {
            log('✓ Popup đã tự mở');
        }

        // Chờ popup login hiện
        log('⏳ Chờ popup login...');
        await page.waitForSelector('#login-dialog', { timeout: 15000 });
        await sleep(2000);

        // Tìm ô email (type="text" + class el-input__inner)
        log('🔎 Tìm ô nhập email...');
        const emailSelectors = [
            '#login-dialog input.el-input__inner',
            '#login-dialog input[placeholder*="email" i]',
            '#login-dialog input[placeholder*="mail" i]',
            '#login-dialog input[placeholder*="địa chỉ" i]'
        ];

        let emailInput = null;
        for (const sel of emailSelectors) {
            const els = await page.$$(sel);
            for (const el of els) {
                if (await el.evaluate(n => n.offsetParent !== null)) {
                    emailInput = el;
                    log(`✓ Tìm thấy email: ${sel}`);
                    break;
                }
            }
            if (emailInput) break;
        }

        if (!emailInput) {
            await page.screenshot({ path: 'debug-step4.png', fullPage: true });
            throw new Error('Không tìm thấy ô email trong popup. Xem debug-step4.png');
        }

        // Điền email
        await emailInput.click({ clickCount: 3 });
        await emailInput.type(mail.address, { delay: 40 });
        await sleep(500);
        log(`✓ Đã điền email: ${mail.address}`);

        // Check TOS checkbox (2 ảnh, ảnh nào display:none là ẩn)
        const tosInfo = await page.evaluate(() => {
            const imgs = document.querySelectorAll('#login-dialog .tos img');
            if (imgs.length === 0) return { found: false };
            const visible = [...imgs].map(i => i.style.display !== 'none');
            return { found: true, count: imgs.length, visible };
        });

        if (tosInfo.found) {
            log(`📋 TOS: ${tosInfo.count} ảnh, visible=${JSON.stringify(tosInfo.visible)}`);
            const isChecked = tosInfo.visible[tosInfo.count - 1] === true;
            if (!isChecked) {
                log('☑️ Click TOS checkbox...');
                await page.evaluate(() => {
                    const firstImg = document.querySelector('#login-dialog .tos img');
                    firstImg?.click();
                });
                await sleep(500);
            } else {
                log('✓ TOS đã check sẵn');
            }
        }

        // Click nút "Đăng nhập/Đăng ký"
        log('🖱️ Click "Đăng nhập/Đăng ký"...');
        const submitText = await page.evaluate(() => {
            const btns = [...document.querySelectorAll('#login-dialog button')];
            for (const btn of btns) {
                if (btn.offsetParent === null) continue;
                const text = (btn.innerText || '').trim();
                if (/đăng\s*nhập|đăng\s*ký|login|sign|continue|get\s*code|xác\s*nhận/i.test(text)) {
                    btn.click();
                    return text.slice(0, 60);
                }
            }
            return null;
        });

        if (submitText) {
            log(`✓ Đã click: "${submitText}"`);
        } else {
            log('⚠️ Không thấy nút submit, thử Enter...');
            await emailInput.press('Enter');
        }

        // ============================================================
        // BƯỚC 5: Giải Aliyun Captcha
        // ============================================================
        setStep(5, 'Giải Aliyun Captcha');
        log('⏳ Chờ captcha data...');
        const waitStart = Date.now();
        while (Date.now() - waitStart < 30000) {
            if (initCaptcha && imageBuffers.back && imageBuffers.shadow) break;
            await sleep(500);
        }

        if (!initCaptcha || !imageBuffers.back || !imageBuffers.shadow) {
            await page.screenshot({ path: 'debug-step5.png', fullPage: true });
            throw new Error('Không bắt được captcha data. Xem debug-step5.png');
        }
        log('✓ Đã có captcha data');

        const capResult = await solveAliyunPuzzle(page, imageBuffers, log, { maxAttempts: 3 });
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
        for (let i = 0; i < 6; i++) {
            await otpInputs[i].type(signupOTP[i], { delay: 80 });
            await sleep(100);
        }

        log('🖱️ Xác nhận OTP...');
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(b => /xác nhận|xác minh|confirm|verify|tiếp tục|hoàn tất/i.test(b.innerText));
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

        await page.goto('https://cloud.vmoscloud.com/settings', { waitUntil: 'domcontentloaded' });
        await sleep(3000);

        log('🖱️ Click "Thay đổi mật khẩu"...');
        await page.evaluate(() => {
            const link = [...document.querySelectorAll('.el-link--primary')].find(a => /thay đổi mật khẩu/i.test(a.innerText));
            link?.click();
        });
        await sleep(2000);

        log('📨 Click "Nhận mã xác minh"...');
        const resetOTPTimeStart = Date.now();
        await page.evaluate(() => {
            document.querySelector('.get-verify-code')?.click();
        });
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

        log('🖱️ Xác nhận...');
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('.el-dialog__footer .el-button--primary')].find(b => /chắc chắn|confirm/i.test(b.innerText));
            btn?.click();
        });
        await sleep(4000);
        log('✅ Đã xử lý đổi password');

        // ============================================================
        // BƯỚC 9: Claim trial
        // ============================================================
        setStep(9, 'Claim trial cloud phone');
        await page.goto('https://cloud.vmoscloud.com/', { waitUntil: 'domcontentloaded' });
        await sleep(4000);

        log('🖱️ Click "Try a cloud phone"...');
        const claimed = await page.evaluate(() => {
            const btn = document.querySelector('.nb-benefit-trial button.nb-primary');
            if (!btn) return false;
            btn.click();
            return true;
        });
        if (claimed) {
            log('✓ Clicked trial');
            await sleep(5000);
        } else {
            log('⚠️ Không thấy nút trial (có thể đã claim)');
        }

        // ============================================================
        // BƯỚC 10: Logout
        // ============================================================
        setStep(10, 'Logout + cleanup');
        await page.goto('https://cloud.vmoscloud.com/settings', { waitUntil: 'domcontentloaded' });
        await sleep(2500);

        await page.evaluate(() => {
            document.querySelector('button.el-button--danger.is-plain')?.click();
        });
        await sleep(3000);
        await page.evaluate(() => { try { localStorage.clear(); } catch {} }).catch(() => {});
        log('🚪 Đã logout');

        // ============================================================
        // RESULT
        // ============================================================
        const result = {
            email: mail.address,
            password: newPassword,
            mailPassword: mail.password,
            timestamp: new Date().toISOString()
        };

        log('');
        log('════════════════════════════════════════════');
        log('✅ HOÀN TẤT');
        log(`📋 Format: ${result.email}|${result.password}|${result.mailPassword}`);
        log('════════════════════════════════════════════');

        socket.emit('result', result);

    } catch (e) {
        log('❌ LỖI: ' + e.message);
        try {
            const pages = await browser?.pages();
            if (pages?.[0]) {
                const p = `error-${Date.now()}.png`;
                await pages[0].screenshot({ path: p, fullPage: true });
                log(`📸 Đã lưu ảnh lỗi: ${p}`);
            }
        } catch {}
        socket.emit('error', e.message);
    } finally {
        try { if (browser) await browser.close(); } catch {}
        try { await stopProxy(proxyInfo, log); } catch {}
        onDone();
    }
}
