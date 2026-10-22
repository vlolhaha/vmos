const sleep = ms => new Promise(r => setTimeout(r, ms));
const OTP_RE = /\b(\d{4,8})\b/;

async function safeJson(res, ctx) {
    const text = await res.text();
    if (!res.ok) throw new Error(`${ctx}: HTTP ${res.status} — ${text.slice(0, 100).replace(/\n/g, ' ')}`);
    try { return JSON.parse(text); }
    catch { throw new Error(`${ctx}: không phải JSON (HTML?)`); }
}

// ============================================================
// HELPERS đọc hòm thư / tách OTP
// ============================================================
function stripHtml(html = '') {
    return String(html)
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&#39;/g, "'")
        .replace(/&quot;/gi, '"')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// Ưu tiên mã 6 số (OTP VMOS), sau đó mới tới 4-8 số
function findOTP(...parts) {
    const text = parts.filter(Boolean).map(String).join('\n');
    const six = text.match(/(?<!\d)(\d{6})(?!\d)/);
    if (six) return six[1];
    const any = text.match(/(?<!\d)(\d{4,8})(?!\d)/);
    return any ? any[1] : null;
}

function sortByDateDesc(messages) {
    return messages.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
}

// ============================================================
// MAIL.TM / MAIL.GW — API + inbox dùng lại session
// ============================================================
async function mailTmApi(session, path, opts = {}) {
    const doFetch = () => fetch(`${session.baseUrl}${path}`, {
        ...opts,
        headers: {
            ...(opts.headers || {}),
            ...(session.token ? { Authorization: 'Bearer ' + session.token } : {})
        }
    });

    let res = await doFetch();

    // Token JWT hết hạn → login lại bằng address/password đã lưu
    if (res.status === 401 && session.password) {
        try {
            const tr = await fetch(`${session.baseUrl}/token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ address: session.address, password: session.password })
            });
            if (tr.ok) {
                const td = await tr.json();
                if (td.token) {
                    session.token = td.token;
                    res = await doFetch();
                }
            }
        } catch {}
    }
    return res;
}

async function mailTmList(session) {
    const res = await mailTmApi(session, '/messages');
    if (!res.ok) throw new Error(`Đọc hộp thư thất bại (HTTP ${res.status})`);
    const data = await res.json();
    return sortByDateDesc((data['hydra:member'] || []).map(m => ({
        id: m.id,
        from: m.from?.address || m.from?.name || '',
        subject: m.subject || '(không có tiêu đề)',
        date: m.createdAt || null,
        preview: m.intro || '',
        otp: findOTP(m.subject, m.intro)
    })));
}

async function mailTmRead(session, id) {
    const res = await mailTmApi(session, `/messages/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Đọc mail thất bại (HTTP ${res.status})`);
    const m = await res.json();
    const text = m.text || stripHtml(m.html || '');
    return {
        id: m.id,
        from: m.from?.address || m.from?.name || '',
        subject: m.subject || '(không có tiêu đề)',
        date: m.createdAt || null,
        text,
        otp: findOTP(m.subject, m.text, stripHtml(m.html || ''))
    };
}

// ============================================================
// 1SECMAIL
// ============================================================
function oneSecParts(session) {
    const [addrLogin, addrDomain] = String(session.address || '').split('@');
    return {
        login: session.login || addrLogin,
        domain: session.domain || addrDomain
    };
}

async function oneSecList(session) {
    const { login, domain } = oneSecParts(session);
    const res = await fetch(`https://www.1secmail.com/api/v1/?action=getMessages&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}`);
    if (!res.ok) throw new Error(`Đọc hộp thư thất bại (HTTP ${res.status})`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('1secmail trả dữ liệu không hợp lệ');
    return sortByDateDesc(list.map(m => ({
        id: String(m.id),
        from: m.from || '',
        subject: m.subject || '(không có tiêu đề)',
        date: m.date || null,
        preview: '',
        otp: findOTP(m.subject, m.from)
    })));
}

async function oneSecRead(session, id) {
    const { login, domain } = oneSecParts(session);
    const res = await fetch(`https://www.1secmail.com/api/v1/?action=readMessage&login=${encodeURIComponent(login)}&domain=${encodeURIComponent(domain)}&id=${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`Đọc mail thất bại (HTTP ${res.status})`);
    const d = await res.json();
    const text = d.textBody || stripHtml(d.htmlBody || d.body || '');
    return {
        id: String(d.id || id),
        from: d.from || '',
        subject: d.subject || '(không có tiêu đề)',
        date: d.date || null,
        text,
        otp: findOTP(d.subject, text)
    };
}

// ============================================================
// GUERRILLAMAIL
// ============================================================
async function guerrillaList(session) {
    const res = await fetch(`https://api.guerrillamail.com/ajax.php?f=check_email&seq=0&sid_token=${encodeURIComponent(session.sid)}`);
    if (!res.ok) throw new Error(`Đọc hộp thư thất bại (HTTP ${res.status})`);
    const d = await res.json();
    return sortByDateDesc((d.list || []).map(m => ({
        id: String(m.mail_id),
        from: m.mail_from || '',
        subject: m.mail_subject || '(không có tiêu đề)',
        date: m.mail_timestamp ? new Date(Number(m.mail_timestamp) * 1000).toISOString() : null,
        preview: m.mail_excerpt || '',
        otp: findOTP(m.mail_subject, m.mail_excerpt)
    })));
}

async function guerrillaRead(session, id) {
    const res = await fetch(`https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${encodeURIComponent(id)}&sid_token=${encodeURIComponent(session.sid)}`);
    if (!res.ok) throw new Error(`Đọc mail thất bại (HTTP ${res.status})`);
    const d = await res.json();
    const text = stripHtml(d.mail_body || '');
    return {
        id: String(d.mail_id || id),
        from: d.mail_from || '',
        subject: d.mail_subject || '(không có tiêu đề)',
        date: d.mail_timestamp ? new Date(Number(d.mail_timestamp) * 1000).toISOString() : null,
        text,
        otp: findOTP(d.mail_subject, text)
    };
}

// ============================================================
// MAILDROP.CC
// ============================================================
async function maildropGql(query) {
    const res = await fetch('https://api.maildrop.cc/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
    });
    if (!res.ok) throw new Error(`maildrop HTTP ${res.status}`);
    return await res.json();
}

async function maildropList(session) {
    const d = await maildropGql(`query { inbox(mailbox: ${JSON.stringify(session.user)}) { id headerfrom subject } }`);
    const inbox = d.data?.inbox || [];
    return inbox.map(m => ({
        id: m.id,
        from: m.headerfrom || '',
        subject: m.subject || '(không có tiêu đề)',
        date: null,
        preview: '',
        otp: findOTP(m.subject, m.headerfrom)
    }));
}

async function maildropRead(session, id) {
    const d = await maildropGql(`query { message(mailbox: ${JSON.stringify(session.user)}, id: ${JSON.stringify(String(id))}) { data headerfrom subject } }`);
    const m = d.data?.message;
    if (!m) throw new Error('Không tìm thấy mail');
    const text = stripHtml(m.data || '');
    return {
        id: String(id),
        from: m.headerfrom || '',
        subject: m.subject || '(không có tiêu đề)',
        date: null,
        text,
        otp: findOTP(m.subject, text)
    };
}

// ============================================================
// INBOXKITTEN
// ============================================================
async function inboxKittenList(session) {
    const res = await fetch(`https://inboxkitten.com/api/v1/mail/list?recipient=${encodeURIComponent(session.address)}`);
    if (!res.ok) throw new Error(`Đọc hộp thư thất bại (HTTP ${res.status})`);
    const list = await res.json();
    if (!Array.isArray(list)) throw new Error('inboxkitten trả dữ liệu không hợp lệ');
    return sortByDateDesc(list.filter(m => m && m.id).map(m => {
        const subject = m.message?.headers?.subject || '';
        const from = m.message?.headers?.from || '';
        const ts = Number(m.timestamp);
        return {
            id: String(m.id),
            from,
            subject: subject || '(không có tiêu đề)',
            date: ts ? new Date(ts * 1000).toISOString() : null,
            preview: '',
            otp: findOTP(subject, from)
        };
    }));
}

async function inboxKittenRead(session, id) {
    const res = await fetch(`https://inboxkitten.com/api/v1/mail/list?recipient=${encodeURIComponent(session.address)}`);
    if (!res.ok) throw new Error(`Đọc hộp thư thất bại (HTTP ${res.status})`);
    const list = await res.json();
    const found = Array.isArray(list) ? list.find(m => String(m.id) === String(id)) : null;
    if (!found) throw new Error('Không tìm thấy mail');

    let text = '';
    try {
        const region = found.storage?.region || '';
        const key = found.storage?.key || '';
        const hr = await fetch(`https://inboxkitten.com/api/v1/mail/getHtml?region=${encodeURIComponent(region)}&key=${encodeURIComponent(key)}`);
        if (hr.ok) text = stripHtml(await hr.text());
    } catch {}

    const subject = found.message?.headers?.subject || '(không có tiêu đề)';
    return {
        id: String(found.id),
        from: found.message?.headers?.from || '',
        subject,
        date: found.timestamp ? new Date(Number(found.timestamp) * 1000).toISOString() : null,
        text,
        otp: findOTP(subject, text)
    };
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

    const session = {
        provider: providerName,
        baseUrl,
        address,
        password,
        token: tData.token
    };

    const self = {
        provider: providerName,
        address,
        password,
        baseUrl,
        token: tData.token,
        session,
        listMessages: () => mailTmList(session),
        readMessage: (id) => mailTmRead(session, id),

        async pollOTP(opts = {}) {
            const { skipCount = 0, timeout = 180000, since = 0 } = opts;
            const t0 = Date.now();
            const seen = new Set();
            let found = 0;

            while (Date.now() - t0 < timeout) {
                try {
                    const r = await mailTmApi(session, '/messages');
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
                                const dr = await mailTmApi(session, `/messages/${m.id}`);
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
    const session = { provider: '1secmail', address, login, domain };
    log(`  ✓ 1secmail: ${address}`);

    const self = {
        provider: '1secmail',
        address,
        password: null,
        baseUrl: 'https://www.1secmail.com',
        token: null,
        session,
        listMessages: () => oneSecList(session),
        readMessage: (id) => oneSecRead(session, id),

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
    const session = { provider: 'guerrillamail', address, sid };
    log(`  ✓ guerrillamail: ${address}`);

    const self = {
        provider: 'guerrillamail',
        address,
        password: null,
        baseUrl: 'https://api.guerrillamail.com',
        token: sid,
        session,
        listMessages: () => guerrillaList(session),
        readMessage: (id) => guerrillaRead(session, id),

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
    const session = { provider: 'maildrop', address, user };
    log(`  ✓ maildrop: ${address}`);

    async function gql(query) {
        return await maildropGql(query);
    }

    const self = {
        provider: 'maildrop',
        address,
        password: null,
        baseUrl: 'https://api.maildrop.cc',
        token: null,
        session,
        listMessages: () => maildropList(session),
        readMessage: (id) => maildropRead(session, id),

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
// PROVIDER 0: inboxkitten.com (không cần register, API đơn giản)
// ============================================================
async function createInboxKitten(log) {
    log('  Thử inboxkitten...');

    const user = 'vmos' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    const address = user + '@inboxkitten.com';
    const session = { provider: 'inboxkitten', address };
    log(`  ✓ inboxkitten: ${address}`);

    const self = {
        provider: 'inboxkitten',
        address,
        password: null,
        baseUrl: 'https://inboxkitten.com',
        token: null,
        session,
        listMessages: () => inboxKittenList(session),
        readMessage: (id) => inboxKittenRead(session, id),

        async pollOTP(opts = {}) {
            const { skipCount = 0, timeout = 180000, since = 0 } = opts;
            const t0 = Date.now();
            const seen = new Set();
            let found = 0;

            while (Date.now() - t0 < timeout) {
                try {
                    const r = await fetch(
                        `https://inboxkitten.com/api/v1/mail/list?recipient=${encodeURIComponent(address)}`
                    );
                    if (!r.ok) { await sleep(3000); continue; }
                    const list = await r.json();
                    if (!Array.isArray(list)) { await sleep(3000); continue; }

                    const msgs = list
                        .filter(m => m && m.id && !seen.has(m.id))
                        .filter(m => !since || (Number(m.timestamp) * 1000) > since)
                        .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

                    for (const m of msgs) {
                        seen.add(m.id);
                        const subj = m.message?.headers?.subject || '';
                        const from = m.message?.headers?.from || '';
                        let match = `${subj} ${from}`.match(/\b(\d{6})\b/);

                        if (!match) {
                            try {
                                const region = m.storage?.region || '';
                                const key = m.storage?.key || '';
                                const hr = await fetch(
                                    `https://inboxkitten.com/api/v1/mail/getHtml?region=${encodeURIComponent(region)}&key=${encodeURIComponent(key)}`
                                );
                                if (hr.ok) {
                                    const html = await hr.text();
                                    // Ưu tiên mã 6 số đứng riêng trong 1 thẻ (div/span)
                                    match = html.match(/>\s*(\d{6})\s*</) ||
                                            html.replace(/<[^>]+>/g, ' ').match(/\b(\d{6})\b/);
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
// ĐỌC HÒM THƯ TỪ SESSION ĐÃ LƯU (dùng cho token OTP 24h)
// ============================================================
function inboxAdapter(session) {
    if (!session || !session.provider) throw new Error('Session hộp thư không hợp lệ');

    switch (session.provider) {
        case 'mail.tm':
        case 'mail.gw':
            if (!session.baseUrl) throw new Error('Thiếu baseUrl của mail provider');
            return {
                listMessages: () => mailTmList(session),
                readMessage: (id) => mailTmRead(session, id)
            };
        case '1secmail':
            return {
                listMessages: () => oneSecList(session),
                readMessage: (id) => oneSecRead(session, id)
            };
        case 'guerrillamail':
            return {
                listMessages: () => guerrillaList(session),
                readMessage: (id) => guerrillaRead(session, id)
            };
        case 'maildrop':
            return {
                listMessages: () => maildropList(session),
                readMessage: (id) => maildropRead(session, id)
            };
        case 'inboxkitten':
            return {
                listMessages: () => inboxKittenList(session),
                readMessage: (id) => inboxKittenRead(session, id)
            };
        default:
            throw new Error('Provider không hỗ trợ đọc hòm thư: ' + session.provider);
    }
}

export async function listInbox(session) {
    return await inboxAdapter(session).listMessages();
}

export async function readInboxMessage(session, id) {
    if (!id) throw new Error('Thiếu ID mail');
    return await inboxAdapter(session).readMessage(id);
}

// ============================================================
// MAIN — thử lần lượt các provider
// ============================================================
const PROVIDERS = [
    { name: 'inboxkitten', fn: (log) => createInboxKitten(log) },
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
