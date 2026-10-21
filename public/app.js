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

// ============================================================
// START
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
    result.innerHTML = '';
    setStatus('run', 'Đang chạy...');

    socket.emit('start-bot', config);
};

$('clearLogs').onclick = () => { logs.innerHTML = 'Sẵn sàng...'; };

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
    result.style.display = 'block';
    result.innerHTML = `
        <div style="margin-bottom:8px;font-size:16px;">
            📋 <strong>Format:</strong> <code style="color:#89b4fa;background:#313244;padding:4px 8px;border-radius:4px;">${data.email}|${data.password}|${data.mailPassword}</code>
        </div>
        <div style="font-size:13px;color:#a6adc8;line-height:1.8;">
            📧 Email VMOS: <span style="color:#cdd6f4;">${data.email}</span><br>
            🔑 Pass VMOS: <span style="color:#a6e3a1;">${data.password}</span><br>
            📮 Pass Mail: <span style="color:#cdd6f4;">${data.mailPassword}</span><br>
            🕐 Time: ${new Date(data.timestamp).toLocaleString('vi-VN')}
        </div>
        <div style="margin-top:12px;">
            <button onclick="copyResult('${data.email}|${data.password}|${data.mailPassword}')" 
                style="background:#89b4fa;color:#11111b;padding:10px 20px;border:none;border-radius:6px;cursor:pointer;font-weight:bold;">
                📋 Copy Format
            </button>
        </div>
    `;
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

// ============================================================
// UTILS
// ============================================================
window.copyResult = (text) => {
    navigator.clipboard.writeText(text).then(() => {
        log('📋 Đã copy: ' + text, 'ok');
    }).catch(e => log('⚠️ Copy thất bại: ' + e.message, 'warn'));
};
