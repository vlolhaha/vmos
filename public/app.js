const socket = io();
const $ = id => document.getElementById(id);

const startBtn = $('startBtn');
const logs = $('logs');
const result = $('result');
const statusDot = $('statusDot');
const statusText = $('statusText');

// ============================================================
// UI HELPERS
// ============================================================
function log(msg, cls = '') {
    const div = document.createElement('div');
    div.textContent = msg;
    if (cls) div.className = cls;
    logs.appendChild(div);
    logs.scrollTop = logs.scrollHeight;
}

function setStatus(state, text) {
    statusDot.className = 'status-dot ' + state;
    statusText.textContent = text;
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        try {
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            const ok = document.execCommand('copy');
            ta.remove();
            return ok;
        } catch {
            return false;
        }
    }
}

window.copyResult = async (text) => {
    const ok = await copyText(text);
    log(ok ? '📋 Đã copy: ' + text : '⚠️ Copy thất bại', ok ? 'ok' : 'warn');
};

// ============================================================
// TABS
// ============================================================
const tabs = [...document.querySelectorAll('.tab')];
const panels = [...document.querySelectorAll('.tab-panel')];

function activateTab(panelId) {
    tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === panelId));
    panels.forEach(p => { p.style.display = p.id === panelId ? 'block' : 'none'; });
}

tabs.forEach(tab => tab.addEventListener('click', () => activateTab(tab.dataset.panel)));

// ============================================================
// START BOT
// ============================================================
startBtn.onclick = () => {
    const config = {
        browser: $('browser').value,
        browserPath: $('browserPath').value.trim() || null,
        headless: $('headless').checked,
        useWarp: $('useWarp').checked
    };

    startBtn.disabled = true;
    logs.innerHTML = '';
    result.style.display = 'none';
    result.replaceChildren();
    setStatus('run', 'Đang chạy...');

    socket.emit('start-bot', config);
};

$('clearLogs').onclick = () => { logs.innerHTML = 'Sẵn sàng...'; };

// ============================================================
// RESULT
// ============================================================
function renderResult(data) {
    const format = `${data.email}|${data.password}|${data.token || ''}`;

    result.style.display = 'block';
    result.replaceChildren();

    const formatLine = document.createElement('div');
    formatLine.className = 'result-format';
    const formatLabel = document.createElement('span');
    formatLabel.textContent = '📋 Format: ';
    const code = document.createElement('code');
    code.className = 'code-pill';
    code.textContent = format;
    formatLine.append(formatLabel, code);

    const details = document.createElement('div');
    details.className = 'result-detail';

    const rows = [
        ['📧 Email VMOS', data.email],
        ['🔑 Pass VMOS', data.password],
        ['🎟️ Token OTP', data.token || '(không có)'],
        ['⏳ Token hết hạn', data.tokenExpiresAt
            ? new Date(data.tokenExpiresAt).toLocaleString('vi-VN')
            : 'sau 24 giờ']
    ];
    if (data.mailPassword) rows.push(['📮 Pass Mail', data.mailPassword]);
    rows.push(['🕐 Time', new Date(data.timestamp).toLocaleString('vi-VN')]);

    for (const [label, value] of rows) {
        const row = document.createElement('div');
        row.textContent = `${label}: ${value}`;
        details.appendChild(row);
    }

    const actions = document.createElement('div');
    actions.className = 'result-actions';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn-copy';
    copyBtn.textContent = '📋 Copy Format';
    copyBtn.onclick = () => window.copyResult(format);
    actions.appendChild(copyBtn);

    if (data.token) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'btn';
        openBtn.textContent = '📥 Mở hòm thư OTP';
        openBtn.onclick = () => {
            tokenInput.value = data.token;
            activateTab('panel-otp');
            openInbox();
        };
        actions.appendChild(openBtn);
    }

    result.append(formatLine, details, actions);
}

// ============================================================
// OTP INBOX (token 24h)
// ============================================================
const tokenInput = $('otpToken');
const openInboxBtn = $('openInboxBtn');
const reloadInboxBtn = $('reloadInboxBtn');
const changeTokenBtn = $('changeTokenBtn');
const inboxCard = $('inboxCard');
const inboxAddress = $('inboxAddress');
const inboxMeta = $('inboxMeta');
const inboxAlert = $('inboxAlert');
const inboxList = $('inboxList');

let currentInbox = null;
let activeToken = '';
let inboxLoading = false;

tokenInput.value = localStorage.getItem('vmos_inbox_token') || '';

// Chấp nhận cả token trơn hoặc cả dòng email|pass|token
function extractToken(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (text.includes('|')) {
        const parts = text.split('|').map(p => p.trim()).filter(Boolean);
        return parts[parts.length - 1] || '';
    }
    return text;
}

function showInboxAlert(message, type = 'warn') {
    if (!message) {
        inboxAlert.style.display = 'none';
        inboxAlert.textContent = '';
        return;
    }
    inboxAlert.className = 'alert ' + type;
    inboxAlert.textContent = message;
    inboxAlert.style.display = 'block';
}

function setInboxBusy(busy) {
    inboxLoading = busy;
    openInboxBtn.disabled = busy;
    reloadInboxBtn.disabled = busy;
    changeTokenBtn.disabled = busy;
    openInboxBtn.textContent = busy ? '⏳ Đang tải...' : '📥 Mở hòm thư';
}

function humanRemaining(ms) {
    if (ms <= 0) return 'đã hết hạn';
    const minutes = Math.ceil(ms / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = minutes % 60;
    if (days > 0) return `còn ${days} ngày ${hours} giờ`;
    if (hours > 0) return `còn ${hours} giờ ${mins} phút`;
    return `còn ${mins} phút`;
}

function updateInboxMeta() {
    if (!currentInbox) return;
    const parts = [];
    if (currentInbox.provider) parts.push(`Provider: ${currentInbox.provider}`);
    if (currentInbox.expiresAt) {
        const exp = Number(currentInbox.expiresAt);
        parts.push(`Token hết hạn: ${new Date(exp).toLocaleString('vi-VN')} (${humanRemaining(exp - Date.now())})`);
    }
    inboxMeta.textContent = parts.join(' • ');
}

function formatMailDate(value) {
    if (!value) return '';
    const t = Date.parse(value);
    return Number.isFinite(t) ? new Date(t).toLocaleString('vi-VN') : String(value);
}

async function fetchInboxMessage(token, id) {
    const res = await fetch(
        `/api/inbox/message?token=${encodeURIComponent(token)}&id=${encodeURIComponent(id)}`,
        { cache: 'no-store' }
    );
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data.message;
}

function buildMailItem(mail) {
    const item = document.createElement('div');
    item.className = 'mail-item';

    const top = document.createElement('div');
    top.className = 'mail-top';

    const subject = document.createElement('div');
    subject.className = 'mail-subject';
    subject.textContent = mail.subject || '(không có tiêu đề)';

    const date = document.createElement('div');
    date.className = 'mail-date';
    date.textContent = formatMailDate(mail.date);

    top.append(subject, date);
    item.appendChild(top);

    if (mail.from) {
        const from = document.createElement('div');
        from.className = 'mail-from';
        from.textContent = 'Từ: ' + mail.from;
        item.appendChild(from);
    }

    if (mail.preview) {
        const preview = document.createElement('div');
        preview.className = 'mail-preview';
        preview.textContent = mail.preview.slice(0, 240);
        item.appendChild(preview);
    }

    if (mail.otp) {
        const row = document.createElement('div');
        row.className = 'otp-row';

        const badge = document.createElement('button');
        badge.type = 'button';
        badge.className = 'otp-badge';
        badge.textContent = 'OTP: ' + mail.otp;
        badge.title = 'Click để copy';
        badge.addEventListener('click', async (e) => {
            e.stopPropagation();
            const old = badge.textContent;
            const ok = await copyText(mail.otp);
            badge.textContent = ok ? '✓ Đã copy' : '⚠️ Copy lỗi';
            setTimeout(() => { badge.textContent = old; }, 1200);
        });

        row.appendChild(badge);
        item.appendChild(row);
    }

    const body = document.createElement('div');
    body.className = 'mail-body';
    body.hidden = true;
    item.appendChild(body);

    let loaded = false;
    item.addEventListener('click', async (e) => {
        if (e.target.closest('button')) return;

        if (!body.hidden) {
            body.hidden = true;
            item.classList.remove('open');
            return;
        }

        body.hidden = false;
        item.classList.add('open');

        if (loaded) return;
        body.textContent = '⏳ Đang tải nội dung...';
        try {
            const detail = await fetchInboxMessage(activeToken, mail.id);
            body.textContent = detail.text || '(Mail không có nội dung văn bản)';
            loaded = true;
        } catch (err) {
            body.textContent = '❌ ' + err.message;
        }
    });

    return item;
}

function renderMessages(messages) {
    inboxList.replaceChildren();

    if (!messages.length) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.innerHTML = '📭 <strong>Hòm thư trống</strong><br>Chờ email OTP mới rồi bấm <strong>Reload</strong>.';
        inboxList.appendChild(empty);
        return;
    }

    for (const mail of messages) inboxList.appendChild(buildMailItem(mail));
}

async function openInbox() {
    if (inboxLoading) return;

    const token = extractToken(tokenInput.value);
    if (!token) {
        showInboxAlert('Nhập token OTP trước.', 'warn');
        tokenInput.focus();
        return;
    }

    tokenInput.value = token;
    const isNewToken = token !== activeToken;
    if (isNewToken) {
        currentInbox = null;
        inboxAddress.textContent = 'Đang mở hòm thư...';
        inboxMeta.textContent = '';
        inboxList.replaceChildren();
        showInboxAlert('', 'ok');
    }
    setInboxBusy(true);

    try {
        const res = await fetch(`/api/inbox?token=${encodeURIComponent(token)}`, { cache: 'no-store' });
        let data = {};
        try { data = await res.json(); } catch {}
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);

        currentInbox = data;
        activeToken = token;
        inboxCard.style.display = 'block';

        localStorage.setItem('vmos_inbox_token', token);
        inboxAddress.textContent = data.address || '—';
        updateInboxMeta();
        renderMessages(data.messages || []);

        if ((data.messages || []).length === 0) {
            showInboxAlert('Hòm thư trống. Chờ OTP rồi bấm Reload.', 'warn');
        } else {
            showInboxAlert('', 'ok');
        }
    } catch (e) {
        inboxCard.style.display = 'block';
        if (!currentInbox) {
            inboxAddress.textContent = 'Không mở được hòm thư';
            inboxMeta.textContent = '';
            inboxList.replaceChildren();
        }
        showInboxAlert('❌ ' + e.message, 'err');
        if (/hết hạn|không hợp lệ/i.test(e.message)) {
            localStorage.removeItem('vmos_inbox_token');
        }
    } finally {
        setInboxBusy(false);
    }
}

openInboxBtn.addEventListener('click', openInbox);
reloadInboxBtn.addEventListener('click', openInbox);
tokenInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openInbox();
});

changeTokenBtn.addEventListener('click', () => {
    currentInbox = null;
    activeToken = '';
    inboxCard.style.display = 'none';
    inboxList.replaceChildren();
    showInboxAlert('', 'ok');
    localStorage.removeItem('vmos_inbox_token');
    tokenInput.value = '';
    tokenInput.focus();
});

setInterval(updateInboxMeta, 30000);

// ============================================================
// SOCKET EVENTS
// ============================================================
socket.on('env:status', (status) => {
    const lines = [];
    if (status.hasDisplay === false) lines.push('⚠️ Không có DISPLAY — chạy `apt install -y xvfb`');
    if (status.hasWarp === false) lines.push('⚠️ WARP service không chạy — bật WARP sẽ fail');

    if (lines.length === 0 && status.hasDisplay !== null) {
        log('✓ Môi trường OK (Xvfb + WARP service)', 'ok');
    } else {
        lines.forEach(l => log(l, 'warn'));
    }
});

socket.on('log', (msg) => {
    let cls = '';
    if (/❌/.test(msg)) cls = 'err';
    else if (/✅|🎉|✓/.test(msg)) cls = 'ok';
    else if (/⚠️/.test(msg)) cls = 'warn';
    else if (/━━━/.test(msg)) cls = 'step';
    log(msg, cls);
});

socket.on('step', ({ n, name }) => {
    setStatus('run', `Bước ${n}/10: ${name}`);
});

socket.on('result', (data) => {
    renderResult(data);

    if (data.token && !currentInbox) tokenInput.value = data.token;
    if (data.token) localStorage.setItem('vmos_inbox_token', data.token);

    log('✅ Có kết quả — Kiểm tra khung bên dưới', 'ok');
    setStatus('done', 'Hoàn tất');
});

socket.on('error', (msg) => {
    log('❌ ' + msg, 'err');
    setStatus('wait', 'Lỗi');
});

socket.on('done', () => {
    startBtn.disabled = false;
    if (statusText.textContent !== 'Lỗi') setStatus('done', 'Kết thúc');
    log('🏁 Tiến trình kết thúc', 'warn');
});
