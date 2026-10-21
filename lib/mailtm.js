const sleep = ms => new Promise(r => setTimeout(r, ms));

// mail.tm và mail.gw là cùng infra, khác domain → fallback lẫn nhau
const PROVIDERS = [
    { name: 'mail.tm', baseUrl: 'https://api.mail.tm' },
    { name: 'mail.gw', baseUrl: 'https://api.mail.gw' }
];

async function safeJson(res, context) {
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`${context}: HTTP ${res.status} — ${text.slice(0, 150).replace(/\n/g, ' ')}`);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new Error(`${context}: response không phải JSON (HTML?) — ${text.slice(0, 100).replace(/\n/g, ' ')}`);
    }
}

async function tryProvider(provider, log) {
    log(`📧 Thử ${provider.name}...`);

    // 1. Lấy domain
    let domain;
    try {
        const res = await fetch(`${provider.baseUrl}/domains`);
        const data = await safeJson(res, `${provider.name}/domains`);
        const domains = data['hydra:member'] || data;
        if (!Array.isArray(domains) || !domains.length) throw new Error('empty list');
        domain = domains[0].domain;
    } catch (e) {
        log(`  ⚠️ ${e.message}`);
        return null;
    }

    const address = 'vmos' + Math.random().toString(36).slice(2, 10) + '@' + domain;
    const password = 'Mail@' + Math.random().toString(36).slice(2, 10) + '1';

    // 2. Create account
    try {
        const res = await fetch(`${provider.baseUrl}/accounts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, password })
        });
        if (!res.ok && res.status !== 422) {
            const text = await res.text();
            log(`  ⚠️ Create HTTP ${res.status}: ${text.slice(0, 150).replace(/\n/g, ' ')}`);
            return null;
        }
    } catch (e) {
        log(`  ⚠️ Create fail: ${e.message}`);
        return null;
    }

    // 3. Get token
    let token;
    try {
        const res = await fetch(`${provider.baseUrl}/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ address, password })
        });
        const data = await safeJson(res, `${provider.name}/token`);
        if (!data.token) throw new Error('no token');
        token = data.token;
    } catch (e) {
        log(`  ⚠️ Token fail: ${e.message}`);
        return null;
    }

    log(`  ✓ OK: ${address}`);
    return { address, password, token, baseUrl: provider.baseUrl, provider: provider.name };
}

export async function createMail(log = console.log) {
    log('📧 Tạo mail...');

    for (let attempt = 1; attempt <= 2; attempt++) {
        for (const provider of PROVIDERS) {
            const mail = await tryProvider(provider, log);
            if (mail) {
                log(`📧 Email: ${mail.address} (${mail.provider})`);
                return mail;
            }
            await sleep(1500); // delay giữa provider
        }
        if (attempt < 2) {
            log('  ⏳ Retry toàn bộ sau 5s...');
            await sleep(5000);
        }
    }

    throw new Error(
        'Tất cả mail provider fail.\n' +
        '→ Nguyên nhân: IP bị block/rate limit (mail.tm + mail.gw cùng Cloudflare).\n' +
        '→ Fix: bật WARP/VPN, đổi mạng 4G, hoặc đợi 10-15 phút.'
    );
}

export async function pollOTP(mailToken, log = console.log, opts = {}) {
    const {
        skipCount = 0,
        timeout = 180000,
        since = 0,
        baseUrl = 'https://api.mail.tm'
    } = opts;

    log(`⏳ Poll OTP (skip=${skipCount}, timeout=${timeout/1000}s)`);

    const t0 = Date.now();
    const seen = new Set();
    let found = 0;
    let errorStreak = 0;

    while (Date.now() - t0 < timeout) {
        try {
            const res = await fetch(`${baseUrl}/messages`, {
                headers: { Authorization: 'Bearer ' + mailToken }
            });

            if (!res.ok) {
                errorStreak++;
                if (errorStreak === 3) log(`⚠️ HTTP ${res.status} lặp lại — có thể token hết hạn`);
                await sleep(3000);
                continue;
            }
            errorStreak = 0;

            const data = await res.json();
            const msgs = (data['hydra:member'] || [])
                .filter(m => !seen.has(m.id))
                .filter(m => !since || new Date(m.createdAt).getTime() > since)
                .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

            for (const m of msgs) {
                seen.add(m.id);
                let match = `${m.subject || ''} ${m.intro || ''}`.match(/\b(\d{6})\b/);

                if (!match) {
                    try {
                        const dRes = await fetch(`${baseUrl}/messages/${m.id}`, {
                            headers: { Authorization: 'Bearer ' + mailToken }
                        });
                        if (dRes.ok) {
                            const detail = await dRes.json();
                            match = `${detail.subject || ''} ${detail.text || ''} ${detail.html || ''}`
                                .match(/\b(\d{6})\b/);
                        }
                    } catch {}
                }

                if (match) {
                    found++;
                    if (found > skipCount) {
                        log(`📨 OTP #${found}: ${match[1]}`);
                        return match[1];
                    }
                    log(`⏭ Bỏ qua OTP #${found}: ${match[1]}`);
                }
            }
        } catch (e) {
            log('⚠️ poll err: ' + e.message);
        }
        await sleep(3000);
    }
    throw new Error('OTP timeout');
}
