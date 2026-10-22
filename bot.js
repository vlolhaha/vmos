import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { createMail } from './lib/mailtm.js';
import { solveAliyunPuzzle } from './lib/aliyun-captcha.js';
import { prepareProxy, stopProxy } from './lib/proxy.js';
import { ensureDisplay, ensureWarpService } from './lib/env-check.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// TÌM BROWSER
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
        if (!hasDisplay) throw new Error('Không có DISPLAY. Chạy: apt install -y xvfb');
    }

    const found = findBrowser(config);
    if (!found) throw new Error('Không tìm thấy Chromium/Chrome. Cài: apt install -y chromium');

    log(`🌐 Browser: ${found.name} — ${found.path}`);

    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
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
// ĐĂNG NHẬP LẠI BẰNG PASSWORD (sau khi đổi password → site logout)
// ============================================================
async function loginWithPassword(page, account, password, log) {
    log('🔐 Đăng nhập lại bằng mật khẩu...');

    // Ưu tiên login qua API: sau khi đổi password, UI có thể còn state logout
    // và trả "operation failed" dù API login hoàn toàn OK.
    try {
        const passwordHash = createHash('md5').update(password).digest('hex');
        const apiLogin = await page.evaluate(async ({ account, passwordHash }) => {
            const r = await fetch('https://api.vmoscloud.com/vcpcloud/api/user/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    mobilePhone: account,
                    loginType: 1,
                    password: passwordHash,
                    channel: 'web'
                })
            });
            let json = null;
            try { json = await r.json(); } catch {}
            return { status: r.status, json };
        }, { account, passwordHash });

        const data = apiLogin?.json?.data;
        if (apiLogin?.json?.code === 200 && data?.token && data?.userId) {
            await page.evaluate((d) => {
                localStorage.setItem('token', d.token);
                localStorage.setItem('userId', String(d.userId));
                let users = [];
                try { users = JSON.parse(localStorage.getItem('users') || '[]'); } catch {}
                if (!Array.isArray(users)) users = [];
                if (!users.some(u => String(u.userId) === String(d.userId))) {
                    users.push({
                        userId: d.userId,
                        customerId: d.customerId,
                        nickName: d.nickName,
                        token: d.token,
                        mobilePhone: d.mobilePhone
                    });
                }
                localStorage.setItem('users', JSON.stringify(users));
            }, data);
            await page.setCookie(
                { name: 'token', value: data.token, domain: '.vmoscloud.com', path: '/' },
                { name: 'userId', value: String(data.userId), domain: '.vmoscloud.com', path: '/' }
            );
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            try {
                await page.waitForFunction(() => {
                    const d = document.querySelector('#login-dialog');
                    return !d || d.offsetParent === null;
                }, { timeout: 20000 });
            } catch {}
            const state = await page.evaluate(() => {
                const d = document.querySelector('#login-dialog');
                return {
                    url: location.href,
                    loginVisible: !!(d && d.offsetParent !== null),
                    token: !!localStorage.getItem('token')
                };
            });
            if (!state.loginVisible) {
                log('✅ Đăng nhập lại bằng API OK');
                return data;
            }
            log('⚠️ API login OK nhưng UI vẫn hiện login dialog: ' + JSON.stringify(state));
        } else {
            log('⚠️ API login thất bại: ' + JSON.stringify(apiLogin).slice(0, 300));
        }
    } catch (e) {
        log('⚠️ API login lỗi: ' + e.message);
    }

    log('↩️ Fallback đăng nhập bằng UI...');

    // Đưa app về trạng thái sạch trước khi login UI (tránh token cũ còn trong bộ nhớ)
    try {
        await page.goto('https://cloud.vmoscloud.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForFunction(() => {
            const d = document.querySelector('#login-dialog');
            return d && d.offsetParent !== null;
        }, { timeout: 15000 });
        await sleep(1000);
    } catch (e) {
        const cleanAuth = await page.evaluate(() => ({
            token: localStorage.getItem('token') || '',
            userId: localStorage.getItem('userId') || ''
        })).catch(() => ({ token: '', userId: '' }));
        if (cleanAuth.token) {
            log('✓ Session đã hoạt động sau reload, bỏ qua UI login');
            return { token: cleanAuth.token, userId: cleanAuth.userId };
        }
        log('⚠️ Không mở được trang login sạch: ' + e.message);
    }

    // VMOS trả checkEmail data:true cho tài khoản vừa tạo (dù đã có password)
    // → UI nhảy sang form đăng ký. Chặn response này để ép hiện panel password.
    const onRequest = (req) => {
        try {
            if (/\/user\/checkEmail/i.test(req.url())) {
                const cors = {
                    'access-control-allow-origin': 'https://cloud.vmoscloud.com',
                    'access-control-allow-credentials': 'true',
                    'access-control-allow-methods': 'GET,POST,OPTIONS',
                    'access-control-allow-headers': req.headers()['access-control-request-headers'] || '*'
                };
                if (req.method() === 'OPTIONS') {
                    req.respond({ status: 204, headers: cors });
                } else {
                    req.respond({
                        status: 200,
                        headers: { ...cors, 'content-type': 'application/json; charset=utf-8' },
                        body: JSON.stringify({ code: 200, msg: 'success', data: false, '2fa': false })
                    });
                }
            } else {
                req.continue();
            }
        } catch {
            try { req.continue(); } catch {}
        }
    };
    // Đăng ký listener TRƯỚC khi bật interception để tránh request bị treo
    page.on('request', onRequest);
    await page.setRequestInterception(true);

    try {
        await page.waitForSelector('#login-dialog', { timeout: 15000 });
        await page.waitForFunction(() => {
            const d = document.querySelector('#login-dialog');
            return d && d.offsetParent !== null;
        }, { timeout: 15000 });
        await sleep(1000);

        // Panel email / user ID
        const accountInput = await page.$(
            '#login-dialog input[placeholder*="email" i], #login-dialog input[placeholder*="user" i]'
        ) || await page.$('#login-dialog input.el-input__inner');
        if (!accountInput) throw new Error('Không thấy ô email/user ID trong login dialog');
        await accountInput.click({ clickCount: 3 });
        await accountInput.type(account, { delay: 40 });
        await sleep(600);

        // TOS mặc định đã check; chỉ click nếu icon "checked" đang ẩn
        const tosVisible = await page.evaluate(() => {
            const imgs = [...document.querySelectorAll('#login-dialog .tos img')];
            return imgs.map(i => i.style.display !== 'none');
        });
        if (tosVisible.length && tosVisible[tosVisible.length - 1] !== true) {
            log('☑️ Check TOS...');
            await page.evaluate(() => document.querySelector('#login-dialog .tos img')?.click());
            await sleep(500);
        }

        const firstName = await page.evaluate(() => {
            const dlg = document.querySelector('#login-dialog');
            const btn = [...dlg.querySelectorAll('button')].find(b =>
                b.offsetParent !== null &&
                b.classList.contains('el-button--primary') &&
                b.classList.contains('el-button--large'));
            btn?.click();
            return btn?.innerText?.trim() || null;
        });
        log(`✓ Click "${firstName || 'Login/Register'}"`);
        await sleep(1800);

        try {
            await page.waitForSelector('#login-dialog input[type="password"]', { timeout: 15000 });
        } catch {
            const text = await page.evaluate(() =>
                document.querySelector('#login-dialog')?.innerText?.slice(0, 800) || '');
            throw new Error('Không hiện panel password: ' + text);
        }

        const pwdInput = await page.$('#login-dialog input[type="password"]');
        await pwdInput.click({ clickCount: 3 });
        await pwdInput.type(password, { delay: 50 });
        await sleep(600);

        const loginClicked = await page.evaluate(() => {
            const dlg = document.querySelector('#login-dialog');
            const btns = [...dlg.querySelectorAll('button')].filter(b => b.offsetParent !== null);
            const btn = btns.find(b =>
                b.classList.contains('el-button--primary') &&
                b.classList.contains('el-button--large')) ||
                btns.find(b => /^(login|sign in)$/i.test((b.innerText || '').trim()));
            btn?.click();
            return btn?.innerText?.trim() || null;
        });
        log(`✓ Click Login: ${loginClicked || '(none)'}`);

        try {
            await page.waitForFunction(() => {
                const d = document.querySelector('#login-dialog');
                return !d || d.offsetParent === null;
            }, { timeout: 20000 });
        } catch {}
        await sleep(3000);

        const state = await page.evaluate(() => {
            const d = document.querySelector('#login-dialog');
            return {
                url: location.href,
                loginVisible: !!(d && d.offsetParent !== null),
                toast: [...document.querySelectorAll('.el-message, .el-notification')]
                    .map(e => (e.innerText || '').trim()).filter(Boolean).join(' | ')
            };
        });
        log('📍 Sau login: ' + JSON.stringify(state));
        if (state.loginVisible) {
            throw new Error('Đăng nhập lại thất bại' + (state.toast ? ': ' + state.toast : ''));
        }
        log('✅ Đăng nhập lại thành công');
    } finally {
        page.off('request', onRequest);
        try { await page.setRequestInterception(false); } catch {}
    }
}

// ============================================================
// AUTH — đồng bộ token từ localStorage sang cookie trước khi reload
// (site mới đọc token từ cookie lúc bootstrap; localStorage có thể chưa kịp ghi)
// ============================================================
async function syncAuthState(page, log, sessionAuth) {
    let auth = await page.evaluate(() => ({
        token: localStorage.getItem('token') || '',
        userId: localStorage.getItem('userId') || '',
        users: localStorage.getItem('users') || ''
    })).catch(() => ({ token: '', userId: '', users: '' }));

    // Fallback: dùng token bắt được từ response đăng nhập/đăng ký
    if ((!auth.token || !auth.userId) && sessionAuth?.token) {
        try {
            await page.evaluate((s) => {
                const user = {
                    userId: s.userId,
                    customerId: s.customerId,
                    nickName: s.nickName || 'VMOS Cloud',
                    token: s.token,
                    mobilePhone: s.mobilePhone || ''
                };
                localStorage.setItem('token', s.token);
                localStorage.setItem('userId', String(s.userId));
                let users = [];
                try { users = JSON.parse(localStorage.getItem('users') || '[]'); } catch {}
                if (Array.isArray(users) && !users.some(u => String(u.userId) === String(s.userId))) {
                    users.push(user);
                }
                localStorage.setItem('users', JSON.stringify(users));
            }, sessionAuth);
            log('🔑 Đã khôi phục auth token từ response đăng nhập');
            auth = await page.evaluate(() => ({
                token: localStorage.getItem('token') || '',
                userId: localStorage.getItem('userId') || '',
                users: localStorage.getItem('users') || ''
            }));
        } catch (e) {
            log('⚠️ Không khôi phục được auth: ' + e.message);
        }
    }

    if (!auth.token) {
        log('⚠️ Không thấy auth token trong localStorage');
        return auth;
    }

    try {
        const cookies = [{ name: 'token', value: auth.token, domain: '.vmoscloud.com', path: '/' }];
        if (auth.userId) {
            cookies.push({ name: 'userId', value: String(auth.userId), domain: '.vmoscloud.com', path: '/' });
        }
        await page.setCookie(...cookies);
        log(`🔑 Auth OK: token ${auth.token.length} ký tự, userId=${auth.userId || '?'}`);
    } catch (e) {
        log('⚠️ Không sync được auth cookie: ' + e.message);
    }
    return auth;
}

// ============================================================
// SETTINGS — mở trang và chờ form render xong (site lazy-load chunk)
// ============================================================
async function openSettingsPage(page, log, sessionAuth) {
    await syncAuthState(page, log, sessionAuth);
    await page.goto('https://cloud.vmoscloud.com/setting', { waitUntil: 'domcontentloaded', timeout: 60000 });

    const start = Date.now();
    let state = null;
    while (Date.now() - start < 25000) {
        state = await page.evaluate(() => {
            const visible = el => !!(el && el.offsetParent !== null);
            const link = [...document.querySelectorAll('a, button')].find(el => {
                if (!visible(el)) return false;
                const text = (el.innerText || el.textContent || '').trim();
                return /change password/i.test(text) && text.length < 40;
            });
            const dlg = document.querySelector('#login-dialog');
            return {
                url: location.href,
                loginVisible: !!(dlg && visible(dlg)),
                hasLink: !!link
            };
        });
        if (state.hasLink && !state.loginVisible) {
            log('✓ Trang Settings đã sẵn sàng');
            return state;
        }
        // Login dialog còn hiện quá lâu → session đã mất, không chờ vô ích
        if (state.loginVisible && Date.now() - start > 12000) break;
        await sleep(500);
    }

    await page.screenshot({ path: 'debug-step8-setting.png', fullPage: true });
    const diag = await page.evaluate(() => {
        const visible = el => !!(el && el.offsetParent !== null);
        const dlg = document.querySelector('#login-dialog');
        return {
            url: location.href,
            loginVisible: !!(dlg && visible(dlg)),
            token: localStorage.getItem('token') ? `present(${localStorage.getItem('token').length})` : 'missing',
            userId: localStorage.getItem('userId') || 'missing',
            cookieToken: /(?:^|;\s*)token=/.test(document.cookie),
            text: (document.body.innerText || '').slice(0, 800)
        };
    }).catch(() => ({}));
    throw new Error('Không mở được trang Settings/Change Password sau 25s: ' + JSON.stringify(diag));
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
    const debug = !!(config.debug || process.env.VMOS_DEBUG === '1');

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
        // BƯỚC 2: Tạo mail (multi-provider)
        // ============================================================
        setStep(2, 'Tạo email');
        mail = await createMail(log); // { provider, address, password, pollOTP(opts) }
        log(`📧 Provider: ${mail.provider} | Email: ${mail.address}`);

        // ============================================================
        // BƯỚC 3: Launch browser
        // ============================================================
        setStep(3, 'Mở Chromium');
        browser = await launchBrowser(config, proxyInfo, log);

        const [page] = await browser.pages();
        if (!page) throw new Error('Không có page nào được mở');

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
        let passwordChangeOk = null;
        let claimTrialResult = null;
        let sessionAuth = null;

        page.on('request', (req) => {
            try {
                if (!debug) return;
                const u = req.url();
                if (req.method() === 'POST' && /api\.vmoscloud\.com|login|sms|user|verify/i.test(u)) {
                    const shortUrl = u.replace('https://api.vmoscloud.com/vcpcloud/api/', '');
                    log(`📡 REQ ${shortUrl}: ${(req.postData() || '').slice(0, 220)}`);
                }
            } catch {}
        });

        page.on('response', async (res) => {
            const url = res.url();
            try {
                if (/\/back\.png/.test(url)) {
                    imageBuffers.back = await res.buffer();
                    imageBuffers.backAt = Date.now();
                    if (debug) log(`📥 back.png (${imageBuffers.back.length}B)`);
                } else if (/\/shadow\.png/.test(url)) {
                    imageBuffers.shadow = await res.buffer();
                    imageBuffers.shadowAt = Date.now();
                    if (debug) log(`📥 shadow.png (${imageBuffers.shadow.length}B)`);
                }

                if (/captcha.*aliyuncs\.com/.test(url) && res.request().method() === 'POST') {
                    const pd = res.request().postData() || '';
                    if (pd.includes('Action=InitCaptcha')) {
                        try {
                            initCaptcha = await res.json();
                            if (debug) log(`📨 InitCaptcha CertifyId=${initCaptcha.CertifyId}`);
                        } catch (e) {}
                    }
                }

                if (/\/sms\/smsSend/.test(url)) {
                    try {
                        const body = await res.text();
                        log(`📤 smsSend: ${body.slice(0, 300)}`);
                    } catch {}
                }

                if (/\/vcpcloud\/api\//.test(url) && !/\/sms\/smsSend/.test(url) && !/\.png/i.test(url)) {
                    try {
                        const body = await res.text();
                        if (debug) {
                            const shortUrl = url.replace('https://api.vmoscloud.com/vcpcloud/api/', '');
                            log(`📡 ${res.status()} ${shortUrl}: ${body.slice(0, 500)}`);
                        }
                        if (/\/user\/updateUserPassword/.test(url)) {
                            try { passwordChangeOk = JSON.parse(body)?.code === 200; } catch {}
                        }
                        if (/\/newUserBenefits\/claimTrial/.test(url)) {
                            try { claimTrialResult = JSON.parse(body); } catch {}
                        }
                        // Bắt token từ response đăng nhập/đăng ký để khôi phục nếu
                        // localStorage chưa kịp ghi trước khi site redirect.
                        try {
                            const data = JSON.parse(body)?.data;
                            if (data?.token && data?.userId) {
                                sessionAuth = {
                                    token: data.token,
                                    userId: data.userId,
                                    customerId: data.customerId,
                                    mobilePhone: data.mobilePhone,
                                    nickName: data.nickName
                                };
                                if (debug) {
                                    log(`🔑 Captured auth từ ${url.replace('https://api.vmoscloud.com/vcpcloud/api/', '')}`);
                                }
                            }
                        } catch {}
                    } catch {}
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

        log('⏳ Chờ popup login...');
        await page.waitForSelector('#login-dialog', { timeout: 15000 });
        await sleep(2000);

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
            throw new Error('Không tìm thấy ô email. Xem debug-step4.png');
        }

        await emailInput.click({ clickCount: 3 });
        await emailInput.type(mail.address, { delay: 40 });
        await sleep(500);
        log(`✓ Đã điền email: ${mail.address}`);

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
            throw new Error('Không bắt được captcha. Xem debug-step5.png');
        }
        log('✓ Đã có captcha data');

        const capResult = await solveAliyunPuzzle(page, imageBuffers, log, { maxAttempts: 3, powDelay: 6000 });
        if (!capResult.success) throw new Error('Captcha fail sau 3 lần');
        log('✅ Captcha passed!');
        await sleep(2000);

        // ============================================================
        // BƯỚC 6: Chờ OTP signup (dùng method của mail object)
        // ============================================================
        setStep(6, 'Chờ OTP đăng ký');
        const signupOTP = await mail.pollOTP({ timeout: 180000 });

        // ============================================================
        // BƯỚC 7: Điền OTP
        // ============================================================
        setStep(7, 'Điền OTP đăng ký');
        await page.waitForSelector('input[type="number"][maxlength="1"]', { timeout: 15000 });

        // Form đăng ký mới yêu cầu Customer ID (dùng làm ID đăng nhập).
        // Dùng local-part của email làm ID: 6-32 ký tự, chỉ chữ/số.
        const customerId = mail.address.split('@')[0];
        const customerInput = await page.$('#registration-customer-id');
        if (customerInput) {
            await customerInput.click({ clickCount: 3 });
            await customerInput.type(customerId, { delay: 40 });
            await sleep(400);
            log(`✓ Customer ID: ${customerId}`);
        } else {
            log('⚠️ Không thấy #registration-customer-id');
        }

        log('⌨️  Điền OTP...');
        const otpInputs = await page.$$('input[type="number"][maxlength="1"]');
        for (let i = 0; i < 6; i++) {
            await otpInputs[i].type(signupOTP[i], { delay: 80 });
            await sleep(180);
        }
        // Auto-submit khi đủ 6 số; chờ component kịp gửi request
        await sleep(1200);

        // onComplete sẽ tự submit; click nút Register dự phòng nếu vẫn còn
        const registerBtn = await page.$('.register-submit');
        if (registerBtn) {
            const disabled = await registerBtn.evaluate(el =>
                el.disabled || el.classList.contains('is-disabled')
            );
            if (!disabled) {
                log('🖱️ Click Register...');
                await registerBtn.click();
            } else {
                log('⚠️ Register button vẫn disabled');
            }
        }

        log('⏳ Chờ xác minh OTP...');
        try {
            await page.waitForFunction(() => {
                const otp = document.querySelector('input[type="number"][maxlength="1"]');
                const dlg = document.querySelector('#login-dialog');
                const loginVisible = !!(dlg && dlg.offsetParent !== null);
                return /new-user-benefits/i.test(location.pathname) ||
                    (!otp && !loginVisible);
            }, { timeout: 20000 });
        } catch {}
        await sleep(2500);

        const postOtp = await page.evaluate(() => {
            const dlg = document.querySelector('#login-dialog');
            const text = document.body.innerText || '';
            return {
                url: location.href,
                loginVisible: !!(dlg && dlg.offsetParent !== null),
                authenticated: /Personal account|个人账号|Tài khoản cá nhân/i.test(text),
                toast: [...document.querySelectorAll('.el-message, .el-notification')]
                    .map(e => (e.innerText || '').trim()).filter(Boolean).join(' | ')
            };
        });
        log('📍 URL sau OTP: ' + postOtp.url);
        if (postOtp.toast) log('🧾 Toast OTP: ' + postOtp.toast);
        if (postOtp.loginVisible ||
            (!postOtp.authenticated && !/new-user-benefits/i.test(postOtp.url))) {
            throw new Error('Đăng ký/OTP thất bại (login dialog=' + postOtp.loginVisible + ')' +
                (postOtp.toast ? ': ' + postOtp.toast : ''));
        }
        log('✓ Đã vào dashboard');

        // ============================================================
        // BƯỚC 8: Đổi mật khẩu
        // ============================================================
        setStep(8, 'Đổi mật khẩu');
        const newPassword = 'Vmos@' + Math.random().toString(36).slice(2, 10) + 'A1';
        log('🔐 Password mới: ' + newPassword);

        await openSettingsPage(page, log, sessionAuth);

        log('🖱️ Click "Change Password"...');
        const clickedChange = await page.evaluate(() => {
            const visible = el => !!(el && el.offsetParent !== null);
            const candidates = [...document.querySelectorAll('a, button')]
                .filter(el => visible(el) && /change password/i.test((el.innerText || el.textContent || '').trim()) && (el.innerText || el.textContent || '').trim().length < 40);
            const target = candidates.find(el => el.tagName === 'A') || candidates[0];
            if (!target) return false;
            target.click();
            return true;
        });
        if (!clickedChange) {
            await page.screenshot({ path: 'debug-step8-setting.png', fullPage: true });
            throw new Error('Không tìm thấy "Change Password". Xem debug-step8-setting.png');
        }

        // Chờ đúng dialog đổi mật khẩu (không phải dialog ẩn nào khác)
        await page.waitForFunction(() => {
            return [...document.querySelectorAll('.el-dialog')].some(d =>
                d.offsetParent !== null &&
                /change password/i.test(d.innerText || '') &&
                !!d.querySelector('input[type="password"]')
            );
        }, { timeout: 15000 });
        await sleep(500);

        const pwdDialogHandle = await page.evaluateHandle(() => {
            return [...document.querySelectorAll('.el-dialog')].find(d =>
                d.offsetParent !== null &&
                /change password/i.test(d.innerText || '') &&
                !!d.querySelector('input[type="password"]')
            );
        });
        const pwdDialog = pwdDialogHandle.asElement();
        if (!pwdDialog) throw new Error('Không tìm thấy dialog đổi mật khẩu đang hiển thị');

        const dialogState = await pwdDialog.evaluate(d => ({
            text: d.innerText.replace(/\s+/g, ' ').slice(0, 600),
            inputs: [...d.querySelectorAll('input')].map(i => ({
                type: i.type, placeholder: i.placeholder, value: i.value, disabled: i.disabled
            }))
        }));
        log('🧾 Dialog state: ' + JSON.stringify(dialogState));

        log('📨 Click "Get code"...');
        const resetOTPTimeStart = Date.now();
        const clickedCode = await pwdDialog.evaluate(d => {
            const el = d.querySelector('.get-verify-code');
            if (!el) return false;
            el.click();
            return true;
        });
        if (!clickedCode) throw new Error('Không tìm thấy nút "Get code"');
        await sleep(2500);
        const toast = await page.evaluate(() =>
            [...document.querySelectorAll('.el-message, .el-notification, .el-message-box')]
                .map(e => (e.innerText || '').trim()).filter(Boolean).join(' | ')
        );
        log('🧾 Toast sau Get code: ' + (toast || '(none)'));

        log('⏳ Chờ OTP đổi password...');
        const resetOTP = await mail.pollOTP({
            timeout: 180000,
            skipCount: 0,
            since: resetOTPTimeStart
        });

        log('⌨️  Điền OTP + password mới...');
        const codeInput = await pwdDialog.$('input[placeholder*="verification" i], input[placeholder*="mã xác minh" i]');
        const pwInput = await pwdDialog.$('input[type="password"]');
        if (!codeInput || !pwInput) {
            const html = await pwdDialog.evaluate(el => el.outerHTML.slice(0, 3000));
            throw new Error('Không tìm thấy input OTP/password trong dialog: ' + html);
        }
        await codeInput.click({ clickCount: 3 });
        await codeInput.type(resetOTP, { delay: 60 });
        await pwInput.click({ clickCount: 3 });
        await pwInput.type(newPassword, { delay: 60 });
        await sleep(500);

        log('🖱️ Xác nhận đổi password...');
        const okBtn = await pwdDialog.$('.el-dialog__footer .el-button--primary');
        if (!okBtn) throw new Error('Không tìm thấy nút OK');
        passwordChangeOk = null;
        await okBtn.click();

        // Chờ API updateUserPassword trả 200
        let pwdOk = null;
        for (let i = 0; i < 60; i++) {
            if (passwordChangeOk !== null) { pwdOk = passwordChangeOk; break; }
            await sleep(500);
        }
        if (pwdOk !== true) {
            await page.screenshot({ path: 'debug-step8-pwdfail.png', fullPage: true });
            const dlgText = await page.evaluate(() =>
                document.querySelector('.el-dialog')?.innerText?.slice(0, 600) || '');
            throw new Error('Đổi password thất bại (API không trả 200): ' + dlgText);
        }
        log('✅ API đổi password OK');
        await sleep(2500);

        // Site gọi logout() sau khi đổi password → login lại bằng password mới
        let loginVisible = false;
        for (let i = 0; i < 10; i++) {
            loginVisible = await page.evaluate(() => {
                const d = document.querySelector('#login-dialog');
                return !!(d && d.offsetParent !== null);
            });
            if (loginVisible) break;
            await sleep(500);
        }
        if (loginVisible) {
            log('🔐 Session đã bị logout sau đổi password');
            const reloginAuth = await loginWithPassword(page, mail.address, newPassword, log);
            if (reloginAuth?.token) sessionAuth = reloginAuth;
        } else {
            log('⚠️ Không thấy login dialog sau đổi password');
        }
        await sleep(1500);
        log('✅ Đã đổi password');

        // ============================================================
        // BƯỚC 9: Claim trial
        // ============================================================
        setStep(9, 'Claim trial cloud phone');
        log('🌐 Mở trang New User Benefits...');
        await syncAuthState(page, log, sessionAuth);
        await page.goto('https://cloud.vmoscloud.com/new-user-benefits', { waitUntil: 'domcontentloaded' });
        await sleep(5000);

        // Chờ nút trial render + enabled
        try {
            await page.waitForFunction(() => {
                const btn = document.querySelector('.nb-benefit-trial button');
                if (!btn) return false;
                const text = (btn.innerText || '').trim();
                return /claim now|去领取|view now|去查看|claimed|已领取/i.test(text);
            }, { timeout: 20000 });
        } catch {}

        const trialState = await page.evaluate(() => {
            const btn = document.querySelector('.nb-benefit-trial button');
            return btn ? {
                text: (btn.innerText || '').trim(),
                disabled: btn.disabled,
                className: btn.className
            } : null;
        });
        log('🎁 Trial button: ' + JSON.stringify(trialState));

        if (!trialState) {
            await page.screenshot({ path: 'debug-step9-notrial.png', fullPage: true });
            throw new Error('Không thấy nút trial. Xem debug-step9-notrial.png');
        }

        if (/view now|去查看|claimed|已领取/i.test(trialState.text)) {
            log('✓ Trial đã được claim trước đó');
        } else if (trialState.disabled) {
            await page.screenshot({ path: 'debug-step9-disabled.png', fullPage: true });
            throw new Error('Nút trial bị disabled: ' + JSON.stringify(trialState));
        } else {
            claimTrialResult = null;
            await page.evaluate(() => {
                document.querySelector('.nb-benefit-trial button')?.click();
            });
            log('🖱️ Đã click Claim now, chờ API claimTrial...');
            let claimRes = null;
            for (let i = 0; i < 60; i++) {
                if (claimTrialResult !== null) { claimRes = claimTrialResult; break; }
                await sleep(500);
            }
            if (!claimRes || claimRes.code !== 200) {
                await page.screenshot({ path: 'debug-step9-claimfail.png', fullPage: true });
                throw new Error('Claim trial thất bại: ' + JSON.stringify(claimRes));
            }
            log('✅ Claim trial OK: ' + JSON.stringify(claimRes.data || claimRes).slice(0, 500));
            await sleep(3000);
            const after = await page.evaluate(() => ({
                successVisible: !!document.querySelector('.nb-success-dialog'),
                dialogText: (document.querySelector('.nb-success-dialog')?.innerText || '').slice(0, 300),
                buttonText: (document.querySelector('.nb-benefit-trial button')?.innerText || '').trim()
            }));
            log('🧾 Sau claim: ' + JSON.stringify(after));
        }

        // ============================================================
        // BƯỚC 10: Logout
        // ============================================================
        setStep(10, 'Logout + cleanup');
        await openSettingsPage(page, log, sessionAuth);

        try {
            await page.waitForFunction(() => {
                return [...document.querySelectorAll('button')].some(b =>
                    b.offsetParent !== null && /log out|退出登录/i.test(b.innerText || ''));
            }, { timeout: 15000 });
        } catch {}

        const logoutClicked = await page.evaluate(() => {
            const btn = [...document.querySelectorAll('button')].find(b =>
                b.offsetParent !== null && /log out|退出登录/i.test(b.innerText || '')) ||
                document.querySelector('button.el-button--danger.is-plain');
            btn?.click();
            return btn ? (btn.innerText || '').trim().slice(0, 40) : null;
        });
        log(logoutClicked ? `🖱️ Click "${logoutClicked}"` : '⚠️ Không thấy nút Log out');
        await sleep(3500);

        let logoutState = await page.evaluate(() => {
            const d = document.querySelector('#login-dialog');
            return {
                url: location.href,
                loginVisible: !!(d && d.offsetParent !== null)
            };
        });
        if (!logoutState.loginVisible) {
            await page.goto('https://cloud.vmoscloud.com/', { waitUntil: 'domcontentloaded' });
            await sleep(3000);
            logoutState = await page.evaluate(() => {
                const d = document.querySelector('#login-dialog');
                return {
                    url: location.href,
                    loginVisible: !!(d && d.offsetParent !== null)
                };
            });
        }
        log('🚪 Logout state: ' + JSON.stringify(logoutState));

        await page.evaluate(() => {
            try { localStorage.clear(); sessionStorage.clear(); } catch {}
        }).catch(() => {});
        log(logoutState.loginVisible ? '🚪 Đã logout (login dialog hiện)' : '⚠️ Đã click logout nhưng chưa thấy login dialog');

        // ============================================================
        // RESULT
        // ============================================================
        const result = {
            email: mail.address,
            password: newPassword,
            mailPassword: mail.password,
            provider: mail.provider,
            timestamp: new Date().toISOString()
        };

        log('');
        log('════════════════════════════════════════════');
        log('✅ HOÀN TẤT');
        log(`📧 Provider: ${result.provider}`);
        log(`📋 Format: ${result.email}|${result.password}|${result.mailPassword || '(no password)'}`);
        log('════════════════════════════════════════════');

        socket.emit('result', result);

    } catch (e) {
        log('❌ LỖI: ' + e.message);
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
