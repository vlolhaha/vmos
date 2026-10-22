import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { runBot } from './bot.js';
import { listInbox, readInboxMessage } from './lib/mailtm.js';
import { getInboxToken, purgeExpiredInboxTokens } from './lib/inbox-store.js';
import { bootstrapEnv } from './lib/env-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Dọn token OTP hết hạn (1 ngày) khi khởi động + mỗi giờ
purgeExpiredInboxTokens();
setInterval(purgeExpiredInboxTokens, 60 * 60 * 1000).unref();

app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// API HÒM THƯ OTP (token sống 24h)
// ============================================================
function readToken(req) {
    return String(req.query.token || '').trim();
}

function requireInbox(req, res) {
    res.set('Cache-Control', 'no-store');
    const token = readToken(req);
    if (!token) {
        res.status(400).json({ ok: false, error: 'Thiếu token OTP' });
        return null;
    }
    const entry = getInboxToken(token);
    if (!entry) {
        res.status(401).json({ ok: false, error: 'Token không hợp lệ hoặc đã hết hạn (1 ngày)' });
        return null;
    }
    return entry;
}

app.get('/api/inbox', async (req, res) => {
    const entry = requireInbox(req, res);
    if (!entry) return;

    const { session, expiresAt, createdAt } = entry;
    try {
        const messages = await listInbox(session);
        res.json({
            ok: true,
            address: session.address,
            provider: session.provider,
            createdAt,
            expiresAt,
            messages
        });
    } catch (e) {
        res.status(502).json({
            ok: false,
            error: 'Không đọc được hòm thư: ' + e.message,
            address: session.address,
            provider: session.provider,
            createdAt,
            expiresAt
        });
    }
});

app.get('/api/inbox/message', async (req, res) => {
    const entry = requireInbox(req, res);
    if (!entry) return;

    const id = String(req.query.id || '').trim();
    if (!id) {
        res.status(400).json({ ok: false, error: 'Thiếu ID mail' });
        return;
    }

    try {
        const message = await readInboxMessage(entry.session, id);
        res.json({ ok: true, message });
    } catch (e) {
        res.status(502).json({ ok: false, error: 'Không đọc được mail: ' + e.message });
    }
});

let running = false;
let envReady = null;

io.on('connection', (socket) => {
    console.log('🟢 Client connected');

    // Gửi trạng thái env cho client
    socket.emit('env:status', envReady || { hasDisplay: null, hasWarp: null });

    socket.on('start-bot', async (config) => {
        if (running) {
            socket.emit('log', '❌ Đang có bot chạy, chờ xong!');
            return;
        }
        running = true;
        socket.emit('log', '🚀 Bắt đầu...');

        runBot(config, socket, () => {
            running = false;
            socket.emit('done');
        }).catch(e => {
            running = false;
            socket.emit('error', e.message);
            socket.emit('done');
        });
    });
});

const PORT = process.env.PORT || 3000;

// Bootstrap env TRƯỚC khi listen
(async () => {
    envReady = await bootstrapEnv((msg) => console.log(msg));
    httpServer.listen(PORT, () => {
        console.log(`\n🌐 Web UI: http://localhost:${PORT}\n`);
        if (!envReady.hasDisplay) {
            console.log('⚠️  Không có display — Chromium sẽ fail. Cài: apt install -y xvfb');
        }
        if (config_useWarp() && !envReady.hasWarp) {
            console.log('⚠️  WARP service không chạy — toggle WARP sẽ fail');
        }
    });
})();

function config_useWarp() {
    return process.env.WARP_ENABLED === 'true';
}
