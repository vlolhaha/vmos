const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function createMail(log = console.log) {
    log('📧 Tạo mail.tm...');
    const domains = (await (await fetch('https://api.mail.tm/domains')).json())['hydra:member'];
    if (!domains?.length) throw new Error('mail.tm không trả domain');

    const domain = domains[0].domain;
    const address = 'vmos' + Math.random().toString(36).slice(2, 10) + '@' + domain;
    const password = 'Mail@' + Math.random().toString(36).slice(2, 10) + '1';

    const c = await fetch('https://api.mail.tm/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password })
    });
    if (!c.ok) throw new Error('mail.tm create fail: ' + await c.text());

    const t = await (await fetch('https://api.mail.tm/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password })
    })).json();
    if (!t.token) throw new Error('mail.tm token fail');

    log('📧 ' + address);
    return { address, password, token: t.token };
}

/**
 * Poll OTP từ mail.tm
 * @param {string} mailToken
 * @param {function} log
 * @param {object} opts { skipCount, timeout, since }
 */
export async function pollOTP(mailToken, log = console.log, opts = {}) {
    const { skipCount = 0, timeout = 180000, since = 0 } = opts;
    log(`⏳ Poll OTP (skip=${skipCount}, timeout=${timeout/1000}s)`);

    const t0 = Date.now();
    const seen = new Set();
    let found = 0;

    while (Date.now() - t0 < timeout) {
        try {
            const data = await (await fetch('https://api.mail.tm/messages', {
                headers: { Authorization: 'Bearer ' + mailToken }
            })).json();

            const msgs = (data['hydra:member'] || [])
                .filter(m => !seen.has(m.id))
                .filter(m => !since || new Date(m.createdAt).getTime() > since)
                .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

            for (const m of msgs) {
                seen.add(m.id);
                let match = `${m.subject || ''} ${m.intro || ''}`.match(/\b(\d{6})\b/);

                if (!match) {
                    const detail = await (await fetch('https://api.mail.tm/messages/' + m.id, {
                        headers: { Authorization: 'Bearer ' + mailToken }
                    })).json();
                    match = `${detail.subject || ''} ${detail.text || ''} ${detail.html || ''}`
                        .match(/\b(\d{6})\b/);
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
