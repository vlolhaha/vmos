import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureWarpService } from './env-check.js';

const execAsync = promisify(exec);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getIP() {
    try {
        const r = await fetch('https://api.ipify.org?format=json');
        return (await r.json()).ip;
    } catch { return 'unknown'; }
}

async function rotateWarp(log) {
    // Đảm bảo service chạy
    const svcOk = await ensureWarpService(log);
    if (!svcOk) return null;

    try {
        log('🌐 Rotate WARP...');
        await execAsync('warp-cli disconnect').catch(() => {});
        await sleep(2000);
        await execAsync('warp-cli connect');
        await sleep(3500);
        const ip = await getIP();
        log('✓ WARP IP mới: ' + ip);
        return { method: 'warp', ip };
    } catch (e) {
        log('⚠️ WARP fail: ' + e.message);
        return null;
    }
}

export async function prepareProxy(log, opts = {}) {
    if (opts.warp) {
        const r = await rotateWarp(log);
        if (r) return r;
        log('⚠️ Không dùng được WARP → tiếp tục với IP gốc');
    }
    log('ℹ️ Dùng IP gốc');
    return { method: 'none' };
}

export async function stopProxy(info, log) {
    if (info?.method === 'warp') {
        try {
            await execAsync('warp-cli disconnect');
            log('✓ Tắt WARP');
        } catch {}
    }
}
