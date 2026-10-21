const sleep = ms => new Promise(r => setTimeout(r, ms));
const OTP_RE = /\b(\d{4,8})\b/;

async function safeJson(res, ctx) {
    const text = await res.text();
    if (!res.ok) throw new Error(`${ctx}: HTTP ${res.status} — ${text.slice(0, 100).replace(/\n/g, ' ')}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`${ctx}: không phải JSON (HTML?)`); }
}

// ============================================================
// PROVIDER 1+2: mail.tm / mail.gw (cần register)
// ============================================================
async function createMailTmProvider(baseUrl, providerName, log) {
    log(`  Thử ${providerName}...`);

    const dRes = await fetch(`${baseUrl}/domains`);
    const dData = await safeJson(dRes, `${providerName}/domains`);
    const domains = dData['hydra:member'] || dData;
    if (!domains?.length) throw new Error('no domain');
    const domain = domains[0].domain;

    const address = 'vmos' + Math.random().toString(36).slice(2, 10) + '@' + domain;
    const password = 'Mail@' + Math.random().toString(36).slice(2, 10) + '1';

    const cRes = await fetch(`${baseUrl}/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password })
    });
    if (!cRes.ok && cRes.status !== 422) {
        throw new Error(`create HTTP ${cRes.status}`);
    }

    const tRes = await fetch(`${baseUrl}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password })
    });
    const tData = await safeJson(tRes, `${providerName}/token`);
    if (!tData.token) throw new Error('no token');

    log(`  ✓ ${providerName}: ${address}`);

    const self = {
        provider: providerName,
        address,
        password,
        baseUrl,
        token: tData.token,

        async pollOTP(opts = {}) {
            const { skipCount = 0, timeout = 180000, since = 0 } = opts;
            const t0 = Date.now();
            const seen = new Set();
            let found = 0;

            while (Date.now() - t0 < timeout) {
                try {
                    const r = await fetch(`${baseUrl}/messages`, {
                        headers: { Authorization: 'Bearer ' + self.token }
                    });
                    if (!r.ok) { await sleep(3000); continue; }
                    const d = await r.json();
                    const msgs = (d['hydra:member'] || [])
                        .filter(m => !seen.has(m.id))
                        .filter(m => !since || new Date(m.createdAt).getTime() > since)
                        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

                    for (const m of msgs) {
                        seen.add(m.id);
                        let match = `${m.subject || ''} ${m.intro || ''}`.match(OTP_RE);
                        if (!match) {
                            try {
                                const dr = await fetch(`${baseUrl}/messages/${m.id}`, {
                                    headers: { Authorization: 'Bearer ' + self.token }
                                });
                                if (dr.ok) {
                                    const detail = await dr.json();
                                    match = `${detail.subject || ''} ${detail.text || ''} ${detail.html || ''}`.match(OTP_RE);
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
                } catch {}
                await sleep(3000);
            }
            throw new Error('OTP timeout');
        }
    };
    return self;
}

// ============================================================
// PROVIDER 3: 1secmail (không cần register)
// ============================================================
async function create1secMail(log) {
    log('  Thử 1secmail...');

    const r = await fetch('https://www.1secmail.com/api/v1/?action=genRandomMailbox&count=1');
    const data = await safeJson(r, '1secmail/gen');
    if (!Array.isArray(data) || !data[0]) throw new Error('no address');

    const address = data[0];
    const [login, domain] = address.split('@');
    log(`  ✓ 1secmail: ${address}`);

    const self = {
        provider: '1secmail',
        address,
        password: null,
        baseUrl: 'https://www.1secmail.com',
        token: null,

        async pollOTP(opts = {}) {
            const { skipCount = 0, timeout = 180000, since = 0 } = opts;
            const t0 = Date.now();
            const seen = new Set();
            let found = 0;

            while (Date.now() - t0 < timeout) {
                try {
                    const r = await fetch(
                        `https://www.1secmail.com/api/v1/?action=getMessages&login=${login}&domain=${domain}`
                    );
                    if (!r.ok) { await sleep(3000); continue; }
                    const msgs = await r.json();
                    if (!Array.isArray(msgs)) { await sleep(3000); continue; }

                    const sorted = msgs
                        .filter(m => !seen.has(m.id))
                        .sort((a, b) => a.id - b.id);

                    for (const m of sorted) {
                        seen.add(m.id);
                        let match = `${m.subject || ''} ${m.from || ''}`.match(OTP_RE);
                        if (!match) {
                            try {
                                const dr = await fetch(
                                    `https://www.1secmail.com/api/v1/?action=readMessage&login=${login}&domain=${domain}&id=${m.id}`
                                );
                                if (dr.ok) {
                                    const detail = await dr.json();
                                    match = `${detail.subject || ''} ${detail.textBody || ''} ${detail.body || ''}`.match(OTP_RE);
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
                } catch {}
                await sleep(3000);
            }
            throw new Error('OTP timeout');
        }
    };
    return self;
}

// ============================================================
// PROVIDER 4: guerrillamail (không cần register, có session)
// ============================================================
async function createGuerrillaMail(log) {
    log('  Thử guerrillamail...');

    const r = await fetch(
        'https://api.guerrillamail.com/ajax.php?f=get_email_address&lang=en&site=guerrillamail.com'
    );
    const data = await safeJson(r, 'guerrilla/get');
    if (!data.email_addr || !data.sid_token) throw new Error('missing email/sid');

    const sid = data.sid_token;
    const address = data.email_addr;
    log(`  ✓ guerrillamail: ${address}`);

    const self = {
        provider: 'guerrillamail',
        address,
        password: null,
        baseUrl: 'https://api.guerrillamail.com',
        token: sid,

        async pollOTP(opts = {}) {
            const { skipCount = 0, timeout = 180000, since = 0 } = opts;
            const t0 = Date.now();
            const seen = new Set();
            let found = 0;

            while (Date.now() - t0 < timeout) {
                try {
                    const r = await fetch(
                        `https://api.guerrillamail.com/ajax.php?f=check_email&seq=0&sid_token=${sid}`
                    );
                    if (!r.ok) { await sleep(3000); continue; }
                    const d = await r.json();
                    const msgs = d.list || [];

                    for (const m of msgs) {
                        const id = String(m.mail_id);
                        if (seen.has(id)) continue;
                        seen.add(id);

                        let match = `${m.mail_subject || ''}`.match(OTP_RE);
                        if (!match) {
                            try {
                                const dr = await fetch(
                                    `https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${id}&sid_token=${sid}`
                                );
                                if (dr.ok) {
                                    const detail = await dr.json();
                                    match = `${detail.mail_subject || ''} ${detail.mail_body || ''}`.match(OTP_RE);
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
                } catch {}
                await sleep(3000);
            }
            throw new Error('OTP timeout');
        }
    };
    return self;
}

// ============================================================
// PROVIDER 5: maildrop.cc (GraphQL, không cần register)
// ============================================================
async function createMaildrop(log) {
    log('  Thử maildrop.cc...');

    const user = 'vmos' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 5);
    const address = user + '@maildrop.cc';
    log(`  ✓ maildrop: ${address}`);

    async function gql(query) {
        const r = await fetch('https://api.maildrop.cc/graphql', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });
        if (!r.ok) throw new Error(`gql HTTP ${r.status}`);
        return await r.json();
    }

    const self = {
        provider: 'maildrop',
        address,
        password: null,
        baseUrl: 'https://api.maildrop.cc',
        token: null,

        async pollOTP(opts = {}) {
            const { skipCount = 0, timeout = 180000, since = 0 } = opts;
            const t0 = Date.now();
            const seen = new Set();
            let found = 0;

            while (Date.now() - t0 < timeout) {
                try {
                    const d = await gql(`query { inbox(mailbox: "${user}") { id headerfrom subject } }`);
                    const msgs = d.data?.inbox || [];

                    for (const m of msgs) {
                        const id = m.id;
                        if (seen.has(id)) continue;
                        seen.add(id);

                        let match = `${m.subject || ''} ${m.headerfrom || ''}`.match(OTP_RE);
                        if (!match) {
                            try {
                                const md = await gql(
                                    `query { message(mailbox: "${user}", id: "${id}") { data } }`
                                );
                                match = `${md.data?.message?.data || ''}`.match(OTP_RE);
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
                } catch {}
                await sleep(3000);
            }
            throw new Error('OTP timeout');
        }
    };
    return self;
}

// ============================================================
// MAIN — thử lần lượt các provider
// ============================================================
const PROVIDERS = [
    { name: 'mail.tm',   fn: (log) => createMailTmProvider('https://api.mail.tm', 'mail.tm', log) },
    { name: '1secmail',  fn: (log) => create1secMail(log) },
    { name: 'mail.gw',   fn: (log) => createMailTmProvider('https://api.mail.gw', 'mail.gw', log) },
    { name: 'guerrilla', fn: (log) => createGuerrillaMail(log) },
    { name: 'maildrop',  fn: (log) => createMaildrop(log) }
];

export async function createMail(log = console.log) {
    log('📧 Tạo email (thử nhiều provider)...');

    const errors = [];
    for (const provider of PROVIDERS) {
        try {
            const mail = await provider.fn(log);
            if (mail) return mail;
        } catch (e) {
            log(`  ⚠️ ${provider.name} fail: ${e.message}`);
            errors.push(`${provider.name}: ${e.message}`);
        }
        await sleep(1000);
    }

    throw new Error(
        'Tất cả mail provider đều fail:\n  ' + errors.join('\n  ') +
        '\n\n→ Fix: bật WARP/VPN, đổi mạng 4G, hoặc đợi 10-15 phút.'
    );
}
