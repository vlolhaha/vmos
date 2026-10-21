const socket = io();
const $ = id => document.getElementById(id);

const startBtn = $('startBtn');
const logs = $('logs');
const result = $('result');

let envReady = false;

// ============================================================
// LOG HELPER
// ============================================================
function log(msg, cls = '') {
    const div = document.createElement('div');
    div.textContent = msg;
    if (cls) div.className = cls;
    logs.appendChild(div);
    logs.scrollTop = logs.scrollHeight;
}

// ============================================================
// START BUTTON
// ============================================================
startBtn.onclick = () => {
    const config = {
        browser: $('browser')?.value || 'auto',
        browserPath: $('browserPath')?.value.trim() || null,
        headless: $('headless')?.checked || false,
        useWarp: $('useWarp')?.checked || false
    };

    startBtn.disabled = true;
    logs.innerHTML = '';
    result.style.display = 'none';
    result.innerHTML = '';

    socket.emit('start-bot', config);
};

// ============================================================
// ENV STATUS
// ============================================================
socket.on('env:status', (status) => {
    envReady = status.hasDisplay !== false;
    const lines = [];
    if (status.hasDisplay === false) {
        lines.push('⚠️ Không có DISPLAY — chạy `apt install -y xvfb`');
    }
    if (status.hasWarp === false) {
        lines.push('⚠️ WARP service không chạy — bật WARP sẽ fail');
    }
    if (lines.length === 0 && status.hasDisplay !== null) {
        log('✓ Môi trường OK (Xvfb + WARP service)', 'ok');
    } else {
        lines.forEach(l => log(l, 'warn'));
    }
});

// ============================================================
// SOCKET EVENTS
// ============================================================
socket.on('log', (msg) => {
    let cls = '';
    if (/❌/.test(msg)) cls = 'err';
    else if (/✅|🎉/.test(msg)) cls = 'ok';
    else if (/⚠️/.test(msg)) cls = 'warn';
    else if (/━━━/.test(msg)) cls = 'step';
    log(msg, cls);
});

socket.on('step', ({ n, name }) => {
    // Step header đã được log qua `log` với dòng ━━━
    // Nhưng nếu bot chưa log, tự thêm:
    // log(`━━━ BƯỚC ${n}/10: ${name} ━━━`, 'step');
});

socket.on('result', (data) => {
    result.style.display = 'block';
    result.innerHTML = `
        <div style="margin-bottom:8px;font-size:16px;">
            📋 <strong>Format:</strong> <code style="color:#89b4fa;">${data.email}|${data.password}|${data.mailPassword}</code>
        </div>
        <div style="font-size:12px;color:#a6adc8;line-height:1.8;">
            📧 VMOS email: ${data.email}<br>
            🔑 VMOS pass: <span style="color:#a6e3a1;">${data.password}</span><br>
            📮 Mail pass: ${data.mailPassword}<br>
            🌐 Proxy: ${data.proxyMethod}${data.proxyIp ? ' (' + data.proxyIp + ')' : ''}<br>
            🕐 ${new Date(data.timestamp).toLocaleString('vi-VN')}
        </div>
        <div style="margin-top:10px;">
            <button onclick="copyResult('${data.email}|${data.password}|${data.mailPassword}')"
                style="background:#89b4fa;color:#11111b;padding:8px 16px;">
                📋 Copy
            </button>
        </div>
    `;
    log('✅ Có kết quả — kiểm tra khung "Kết quả" bên dưới', 'ok');
});

socket.on('error', (msg) => {
    log('❌ ' + msg, 'err');
});

socket.on('done', () => {
    startBtn.disabled = false;
    log('🏁 Tiến trình kết thúc', 'warn');
});

// ============================================================
// UTILS
// ============================================================
window.copyResult = (text) => {
    navigator.clipboard.writeText(text).then(() => {
        log('📋 Đã copy: ' + text, 'ok');
    }).catch(e => log('⚠️ Copy fail: ' + e.message, 'warn'));
};
