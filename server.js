import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import { runBot } from './bot.js';
import { bootstrapEnv } from './lib/env-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(path.join(__dirname, 'public')));

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
