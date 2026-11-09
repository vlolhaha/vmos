import os from 'node:os';
import path from 'node:path';
import { createMail } from './mailtm.js';
import { createInboxToken } from './inbox-store.js';
import { solveAliyunPuzzle } from './aliyun-captcha.js';
import { prepareProxy, stopProxy } from './proxy.js';
import { ensureWarpService } from './env-check.js';
import { launchBrowser } from '../bot.js';

const LOGIN_URL = 'https://cloud.vsphone.com/login';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SEL = {
    email: 'input[placeholder*="email" i]',
    code: 'input[placeholder*="verification code" i]',
    password: 'input[type="password"]',
    getCode: '#get-captcha-code'
};

function randomPassword() {
    const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let tail = '';
    for (let i = 0; i < 8; i++) {
        tail += chars[Math.floor(Math.random() * chars.length)];
    }
    return 'Vsphone@' + tail;
}

async function waitVisible(page, selector, timeout = 15000) {
    await page.waitForFunction(sel => {
        const el = document.querySelector(sel);
        return !!(el && el.offsetParent !== null);
    }, { timeout }, selector);
}

async function fillInput(page, selector, value, delay = 35) {
    await waitVisible(page, selector);
    await page.click(selector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(selector, value, { delay });
}

async function clickButtonByText(page, re) {
    const clicked = await page.evaluate(source => {
        const rx = new RegExp(source, 'i');
        const btn = [...document.querySelectorAll('button')].find(b =>
            b.offsetParent !== null && rx.test((b.innerText || '').trim())
        );
        if (!btn) return null;
        const text = (btn.innerText || '').trim();
        btn.click();
        return text;
    }, re.source);

    if (!clicked) throw new Error(`Không tìm thấy nút ${re}`);
    return clicked;
}

async function extractCaptcha(page) {
    return page.evaluate(() => {
        const get = id => {
            const el = document.getElementById(id);
            return el?.src?.startsWith('data:') ? el.src.split(',')[1] : null;
        };
        return { back: get('aliyunCaptcha-img'), shadow: get('aliyunCaptcha-puzzle') };
    });
}

async function waitForCaptchaState(page, timeout = 15000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        const state = await page.evaluate(() => {
            const slider = document.querySelector(
                '#aliyunCaptcha-sliding-slider, .aliyunCaptcha-sliding-slider, [class*="slider-move"], .captcha-slider-btn, [class*="slider-btn"]'
            );
            const sliderVisible = !!(slider && slider.offsetParent !== null);
            const error = /Failed to load the captcha component|Please try again later/i.test(document.body.innerText);
            const sent = /retrieve in\s*(?:\d+\s*)?seconds/i.test(document.body.innerText);
            return { sliderVisible, error, sent };
        });
        if (state.sliderVisible) return 'ready';
        if (state.sent) return 'sent';
        if (state.error) return 'error';
        await sleep(500);
    }
    return 'timeout';
}

async function openCaptcha(page, imageBuffers, log) {
    for (let attempt = 1; attempt <= 3; attempt++) {
        imageBuffers.back = null;
        imageBuffers.shadow = null;
        imageBuffers.backAt = 0;
        imageBuffers.shadowAt = 0;

        await page.click(SEL.getCode);
        log(`🖱️ Click "Get code" (lần ${attempt}/3)`);

        const state = await waitForCaptchaState(page);
        if (state === 'ready') return 'ready';
        if (state === 'sent') return 'sent';

        if (state === 'error') {
            log('⚠️ Captcha component load lỗi — đóng popup và thử lại...');
            await page.evaluate(() => {
                const ok = [...document.querySelectorAll('button')].find(b =>
                    /^ok$/i.test((b.innerText || '').trim())
                );
                ok?.click();
            });
        } else {
            log('⚠️ Không thấy slider captcha — thử lại...');
        }
        await sleep(2000);
    }
    return 'failed';
}

async function waitForCaptchaImages(page, imageBuffers, log) {
    for (let i = 0; i < 30; i++) {
        const data = await extractCaptcha(page);
        if (data.back && data.shadow) {
            imageBuffers.back = Buffer.from(data.back, 'base64');
            imageBuffers.shadow = Buffer.from(data.shadow, 'base64');
            imageBuffers.backAt = Date.now();
            imageBuffers.shadowAt = Date.now();
            return true;
        }
        if (imageBuffers.back && imageBuffers.shadow) return true;
        await sleep(500);
    }
    log('⚠️ Không lấy được ảnh captcha từ DOM/network');
    return false;
}

async function readPageError(page) {
    return page.evaluate(() => {
        const selectors = [
            '.el-message--error',
            '.el-message',
            '.el-form-item__error',
            '.el-notification',
            '[class*="toast"]'
        ];
        for (const sel of selectors) {
            const el = [...document.querySelectorAll(sel)].find(e =>
                e.offsetParent !== null && (e.innerText || '').trim()
            );
            if (el) return el.innerText.trim().replace(/\s+/g, ' ').slice(0, 300);
        }
        return '';
    });
}

export async function runVsPhoneBot(config, socket, onDone) {
    const log = (msg) => {
        const line = `[${new Date().toTimeString().slice(0, 8)}] ${msg}`;
        console.log(line);
        socket.emit('log', line);
    };
    const setStep = (n, name) => {
        socket.emit('step', { n, total: 8, name });
        log(`\n━━━ BƯỚC ${n}/8: ${name} ━━━`);
    };
    const debug = !!(config.debug || process.env.VSPHONE_DEBUG === '1');

    let browser = null;
    let proxyInfo = { method: 'none' };
    let mail = null;

    try {
        setStep(1, 'Đổi proxy/VPN');
        const useWarp = config.useWarp || process.env.WARP_ENABLED === 'true';
        if (useWarp) await ensureWarpService(log);
        proxyInfo = await prepareProxy(log, { warp: useWarp });

        setStep(2, 'Tạo email');
        mail = await createMail(log);
        log(`📧 Provider: ${mail.provider} | Email: ${mail.address}`);

        let inboxToken = null;
        let inboxExpiresAt = null;
        try {
            const inbox = createInboxToken(mail);
            inboxToken = inbox.token;
            inboxExpiresAt = inbox.expiresAt;
            log(`🔑 Token OTP (24h): ${inboxToken} — hết hạn ${new Date(inboxExpiresAt).toLocaleString('vi-VN')}`);
        } catch (e) {
            log('⚠️ Không tạo được token OTP: ' + e.message);
        }

        setStep(3, 'Mở Chromium');
        browser = await launchBrowser(config, proxyInfo, log);
        const [page] = await browser.pages();
        if (!page) throw new Error('Không có page nào được mở');

        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            window.chrome = { runtime: {} };
        });
        log('✓ Anti-detect injected');

        const imageBuffers = {};
        page.on('response', async (res) => {
            try {
                const url = res.url();
                if (/\/back\.png(\?|$)/.test(url)) {
                    imageBuffers.back = await res.buffer();
                    imageBuffers.backAt = Date.now();
                    if (debug) log(`📥 back.png (${imageBuffers.back.length}B)`);
                } else if (/\/shadow\.png(\?|$)/.test(url)) {
                    imageBuffers.shadow = await res.buffer();
                    imageBuffers.shadowAt = Date.now();
                    if (debug) log(`📥 shadow.png (${imageBuffers.shadow.length}B)`);
                }
            } catch {}
        });

        if (debug) {
            page.on('request', (req) => {
                try {
                    const url = req.url();
                    if (req.method() === 'POST' && /api\.vsphone\.com/.test(url)) {
                        log(`📡 ${url.split('/vsphone/api/')[1] || url}: ${(req.postData() || '').slice(0, 220)}`);
                    }
                } catch {}
            });
        }

        setStep(4, 'Mở trang đăng ký');
        await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 60000 });
        await waitVisible(page, SEL.email, 30000);
        log('✓ Đã mở trang đăng nhập/đăng ký');

        await fillInput(page, SEL.email, mail.address);
        await sleep(800);

        const loginBtn = await clickButtonByText(page, /login\/register|register and log in/i);
        log(`🖱️ Click "${loginBtn}"`);

        await waitVisible(page, SEL.code, 15000);
        await waitVisible(page, SEL.getCode, 15000);
        log('✓ Form đăng ký đã hiện');

        setStep(5, 'Gửi mã xác minh');
        const captchaState = await openCaptcha(page, imageBuffers, log);

        if (captchaState === 'ready') {
            setStep(6, 'Giải captcha');
            const imagesReady = await waitForCaptchaImages(page, imageBuffers, log);
            if (!imagesReady) throw new Error('Không tải được ảnh captcha Aliyun');

            const captcha = await solveAliyunPuzzle(page, imageBuffers, log, {
                maxAttempts: 3,
                powDelay: 6000
            });
            if (!captcha.success) {
                throw new Error('Giải captcha thất bại: ' + (captcha.reason || 'unknown'));
            }
            log('✓ Captcha đã pass — chờ email OTP');
        } else if (captchaState === 'sent') {
            log('ℹ️ Không có captcha, mã xác minh đã được gửi — chờ email OTP...');
        } else {
            throw new Error('Captcha Aliyun không tải được sau 3 lần thử');
        }

        setStep(7, 'Nhập OTP & mật khẩu');
        const otp = await mail.pollOTP({ timeout: 180000 });
        await fillInput(page, SEL.code, otp, 60);

        const password = randomPassword();
        await fillInput(page, SEL.password, password, 45);

        await page.evaluate(() => {
            const cb = document.querySelector('.el-checkbox__original');
            if (cb && !cb.checked) cb.click();
        });
        await sleep(600);

        const registerBtn = await clickButtonByText(page, /register and log in/i);
        log(`🖱️ Click "${registerBtn}"`);

        setStep(8, 'Xác nhận tài khoản');
        let auth = null;
        for (let i = 0; i < 45; i++) {
            auth = await page.evaluate(() => {
                let users = [];
                try {
                    users = JSON.parse(localStorage.getItem('users') || '[]');
                } catch {}
                return {
                    token: localStorage.getItem('token') || '',
                    userId: localStorage.getItem('userId') || String(users[0]?.userId || ''),
                    users
                };
            });
            if (auth.token) break;
            await sleep(1000);
        }

        if (!auth?.token) {
            const pageError = await readPageError(page);
            throw new Error('Đăng ký không thành công' + (pageError ? ': ' + pageError : ' (không thấy token đăng nhập)'));
        }

        log(`✓ Đăng ký thành công — userId=${auth.userId || '?'}`);

        const result = {
            service: 'vsphone',
            email: mail.address,
            password,
            token: inboxToken,
            tokenExpiresAt: inboxExpiresAt,
            accountToken: auth.token,
            userId: auth.userId || null,
            provider: mail.provider,
            loginUrl: LOGIN_URL,
            timestamp: new Date().toISOString()
        };

        log('');
        log('════════════════════════════════════════════');
        log('✅ HOÀN TẤT VSPhone');
        log(`📧 Provider: ${result.provider}`);
        log(`📋 Account: ${result.email}|${result.password}|${result.token || ''}`);
        log(`🆔 User ID: ${result.userId || '(không có)'}`);
        log('════════════════════════════════════════════');

        socket.emit('result', result);
    } catch (e) {
        log('❌ LỖI: ' + e.message);
        try {
            const pages = await browser?.pages();
            if (pages?.[0]) {
                const file = path.join(os.tmpdir(), `vsphone-error-${Date.now()}.png`);
                await pages[0].screenshot({ path: file, fullPage: true });
                log(`📸 Screenshot: ${file}`);
            }
        } catch {}
        socket.emit('error', e.message);
    } finally {
        try { if (browser) await browser.close(); } catch {}
        try { await stopProxy(proxyInfo, log); } catch {}
        onDone();
    }
}
