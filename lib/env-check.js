import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// XVFB — auto start nếu không có DISPLAY (Linux only)
// ============================================================
let xvfbProcess = null;

export async function ensureDisplay(log = console.log) {
    if (process.platform !== 'linux') return true;

    // Đã có DISPLAY? Kiểm tra display còn sống thật (tránh socket/lock cũ)
    if (process.env.DISPLAY) {
        try {
            await execFileAsync('xdpyinfo', ['-display', process.env.DISPLAY], { timeout: 2000 });
            log(`✓ DISPLAY đã set: ${process.env.DISPLAY}`);
            return true;
        } catch (e) {
            if (e.code === 'ENOENT') {
                // Không có xdpyinfo để kiểm tra → giữ hành vi cũ
                log(`✓ DISPLAY đã set: ${process.env.DISPLAY}`);
                return true;
            }
            log(`⚠️ DISPLAY=${process.env.DISPLAY} không phản hồi — thử start Xvfb...`);
        }
    }

    log('⚠️ Không có DISPLAY — thử start Xvfb...');

    // Có Xvfb không?
    try {
        await execAsync('which Xvfb');
    } catch {
        log('❌ Xvfb chưa cài. Chạy: apt install -y xvfb');
        return false;
    }

    // Check Xvfb :99 đã chạy chưa
    try {
        const { stdout } = await execAsync('pgrep -f "Xvfb :99" || true');
        if (stdout.trim()) {
            log('✓ Xvfb :99 đã chạy sẵn');
            process.env.DISPLAY = ':99';
            return true;
        }
    } catch {}

    // Không có process Xvfb → dọn socket/lock chết còn sót lại
    try {
        await execAsync('mkdir -p /tmp/.X11-unix && rm -f /tmp/.X99-lock /tmp/.X11-unix/X99');
    } catch {}

    // Start Xvfb
    log('🚀 Start Xvfb :99...');
    try {
        // Không await — chạy nền
        const { spawn } = await import('node:child_process');
        xvfbProcess = spawn('Xvfb', [':99', '-screen', '0', '1280x900x24'], {
            detached: true,
            stdio: 'ignore'
        });
        xvfbProcess.unref();

        await sleep(1500);
        process.env.DISPLAY = ':99';
        log('✓ Xvfb :99 đã chạy — DISPLAY=' + process.env.DISPLAY);
        return true;
    } catch (e) {
        log('❌ Start Xvfb fail: ' + e.message);
        return false;
    }
}

// ============================================================
// WARP SERVICE — auto start nếu chưa chạy
// ============================================================
export async function ensureWarpService(log = console.log) {
    if (process.platform !== 'linux') {
        // Windows/Mac: warp-cli tự quản lý
        return true;
    }

    // Check warp-cli có tồn tại không
    try {
        await execAsync('which warp-cli');
    } catch {
        log('⚠️ warp-cli chưa cài → bỏ qua WARP');
        return false;
    }

    // Check service
    try {
        const { stdout } = await execAsync('systemctl is-active warp-svc 2>/dev/null || echo inactive');
        const status = stdout.trim();

        if (status === 'active') {
            log('✓ warp-svc đang chạy');
            return true;
        }

        log('⚠️ warp-svc chưa chạy, thử start...');
        await execAsync('systemctl start warp-svc');
        await sleep(2000);

        const { stdout: s2 } = await execAsync('systemctl is-active warp-svc');
        if (s2.trim() === 'active') {
            log('✓ warp-svc đã start');
            return true;
        }
        throw new Error('status=' + s2.trim());
    } catch (e) {
        log('❌ Start warp-svc fail: ' + e.message);

        // Fallback: thử warp-svc trực tiếp (không qua systemd)
        try {
            log('🔄 Thử chạy warp-svc trực tiếp...');
            const { spawn } = await import('node:child_process');
            const svc = spawn('warp-svc', [], { detached: true, stdio: 'ignore' });
            svc.unref();
            await sleep(2500);

            await execAsync('warp-cli status');
            log('✓ warp-svc trực tiếp OK');
            return true;
        } catch (e2) {
            log('❌ warp-svc trực tiếp fail: ' + e2.message);
            return false;
        }
    }
}

// ============================================================
// CHECK DẪU ĐỦ LIBS (Linux)
// ============================================================
export async function ensureLibs(log = console.log) {
    if (process.platform !== 'linux') return true;

    // Một số distro mới (Ubuntu 24.04+) đổi tên package sang hậu tố "t64".
    // Kiểm tra cả tên cũ và tên mới để tránh báo thiếu lib sai.
    const required = [
        { label: 'libnss3', packages: ['libnss3'] },
        { label: 'libatk-bridge2.0-0', packages: ['libatk-bridge2.0-0', 'libatk-bridge2.0-0t64'] },
        { label: 'libgbm1', packages: ['libgbm1'] },
        { label: 'libasound2', packages: ['libasound2', 'libasound2t64'] },
        { label: 'libxkbcommon0', packages: ['libxkbcommon0'] },
        { label: 'libxdamage1', packages: ['libxdamage1'] }
    ];

    async function isInstalled(pkg) {
        try {
            await execAsync(`dpkg -s ${pkg} 2>/dev/null`);
            return true;
        } catch {
            return false;
        }
    }

    try {
        const missing = [];
        for (const lib of required) {
            let installed = false;
            for (const pkg of lib.packages) {
                if (await isInstalled(pkg)) {
                    installed = true;
                    break;
                }
            }
            if (!installed) missing.push(lib.label);
        }
        if (missing.length) {
            log('⚠️ Thiếu libs Chromium: ' + missing.join(', '));
            log('  Chạy: apt install -y ' + missing.join(' '));
        } else {
            log('✓ Đủ libs Chromium');
        }
        return true;
    } catch {
        return true;
    }
}

// ============================================================
// FULL BOOTSTRAP
// ============================================================
export async function bootstrapEnv(log = console.log) {
    log('\n🔧 Bootstrap môi trường...');
    await ensureLibs(log);

    const hasDisplay = await ensureDisplay(log);

    // Chỉ kiểm tra WARP khi thực sự bật, tránh log cảnh báo gây hiểu nhầm.
    const warpEnabled = process.env.WARP_ENABLED === 'true';
    const hasWarp = warpEnabled ? await ensureWarpService(log) : false;

    return { hasDisplay, hasWarp, warpEnabled };
}

// ============================================================
// CLEANUP
// ============================================================
export async function cleanupEnv(log = console.log) {
    if (xvfbProcess) {
        try {
            log('🧹 Kill Xvfb...');
            xvfbProcess.kill();
            xvfbProcess = null;
        } catch {}
    }
}

process.on('SIGINT',  () => { cleanupEnv().then(() => process.exit(0)); });
process.on('SIGTERM', () => { cleanupEnv().then(() => process.exit(0)); });
