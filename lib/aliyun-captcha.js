import sharp from 'sharp';
import fs from 'node:fs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ============================================================
// DETECT GAP trong back.png
// ============================================================
async function detectGap(backBuf, log) {
    const { data, info } = await sharp(backBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    let alphaMin = 255, alphaMax = 0;
    for (let i = 3; i < data.length; i += channels) {
        if (data[i] < alphaMin) alphaMin = data[i];
        if (data[i] > alphaMax) alphaMax = data[i];
    }
    const useAlpha = (alphaMax - alphaMin) > 30;
    log(`  Alpha: ${alphaMin}-${alphaMax} → detect bằng ${useAlpha ? 'alpha' : 'màu xám'}`);

    const isGap = (idx) => {
        if (useAlpha) return data[idx + 3] < 100;
        const r = data[idx], g = data[idx + 1], b = data[idx + 2];
        const md = Math.max(Math.abs(r - g), Math.abs(g - b), Math.abs(r - b));
        const avg = (r + g + b) / 3;
        return md < 15 && avg > 80 && avg < 200;
    };

    const visited = new Uint8Array(width * height);
    let best = null;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            if (visited[i]) continue;
            visited[i] = 1;
            if (!isGap(i * channels)) continue;

            const queue = [[x, y]];
            let count = 0, sumX = 0;
            let minX = x, maxX = x, minY = y, maxY = y;

            while (queue.length) {
                const [cx, cy] = queue.pop();
                count++;
                sumX += cx;
                if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
                if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;

                for (const [dx, dy] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,1],[-1,1],[1,-1]]) {
                    const nx = cx + dx, ny = cy + dy;
                    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
                    const ni = ny * width + nx;
                    if (visited[ni]) continue;
                    visited[ni] = 1;
                    if (isGap(ni * channels)) queue.push([nx, ny]);
                }
            }

            const w = maxX - minX + 1, h = maxY - minY + 1;
            if (w >= 30 && w <= 100 && h >= 30 && h <= 100 && count >= 500 &&
                Math.abs(w - h) < 20 && minX > width * 0.15) {
                if (!best || count > best.count) {
                    best = { centerX: sumX / count, minX, maxX, minY, maxY, w, h, count };
                }
            }
        }
    }

    if (!best) throw new Error('Không detect được gap');
    log(`  ✓ Gap ${best.w}x${best.h} minX=${best.minX} count=${best.count}`);
    return best;
}

// ============================================================
// DETECT PIECE trong shadow.png
// ============================================================
async function detectPiece(shadowBuf, log) {
    const { data, info } = await sharp(shadowBuf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width, height, channels } = info;

    let sumX = 0, count = 0;
    let minX = width, maxX = 0, minY = height, maxY = 0;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * channels;
            if (data[idx + 3] > 150) {
                sumX += x;
                count++;
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
            }
        }
    }

    if (count < 100) throw new Error('Không detect được piece');
    log(`  ✓ Piece ${maxX - minX + 1}x${maxY - minY + 1} minX=${minX} count=${count}`);
    return { centerX: sumX / count, minX, maxX, minY, maxY, count };
}

// ============================================================
// TRAJECTORY human-like
// ============================================================
function generateTrajectory(distance) {
    const track = [];
    let t = 0;

    // Phase 1: acceleration
    const accel = 5 + Math.floor(Math.random() * 4);
    for (let i = 1; i <= accel; i++) {
        const p = i / accel;
        const x = distance * 0.6 * (1 - Math.pow(1 - p, 3));
        t += 15 + Math.random() * 12;
        track.push({ x: Math.round(x), y: Math.round((Math.random() - 0.5) * 2), t });
    }

    // Phase 2: deceleration
    const decel = 4 + Math.floor(Math.random() * 3);
    const startX = distance * 0.6;
    for (let i = 1; i <= decel; i++) {
        const p = i / decel;
        const x = startX + distance * 0.4 * p;
        t += 30 + Math.random() * 25;
        track.push({ x: Math.round(x), y: Math.round((Math.random() - 0.5) * 3), t });
    }

    // Phase 3: micro-adjust
    for (let i = 0; i < 2 + Math.floor(Math.random() * 2); i++) {
        const x = distance + (Math.random() - 0.5) * 4;
        t += 40 + Math.random() * 30;
        track.push({ x: Math.round(x), y: Math.round((Math.random() - 0.5) * 2), t });
    }

    track.push({ x: distance, y: 0, t: t + 60 });
    return track;
}

// ============================================================
// REPLAY
// ============================================================
async function replay(page, startX, startY, track, log) {
    log(`  🖱️ Replay ${track.length} điểm / ${track[track.length - 1].t}ms`);
    await page.mouse.move(startX, startY);
    await sleep(100 + Math.random() * 80);
    await page.mouse.down();
    await sleep(80 + Math.random() * 50);

    const tStart = Date.now();
    for (const p of track) {
        const wait = p.t - (Date.now() - tStart);
        if (wait > 0) await sleep(wait);
        await page.mouse.move(startX + p.x, startY + p.y);
    }
    await sleep(80 + Math.random() * 120);
    await page.mouse.up();
}

// ============================================================
// FIND SLIDER
// ============================================================
async function findSlider(page, log) {
    const info = await page.evaluate(() => {
        const containerSels = [
            '.aliyun-captcha', '#aliyun-captcha',
            '[class*="aliyun-captcha"]', '[class*="captcha-slide"]',
            '.nc-container', '.captcha-container', '.el-dialog:has(img)'
        ];
        let container = null;
        for (const sel of containerSels) {
            const el = document.querySelector(sel);
            if (el && el.offsetParent !== null) { container = el; break; }
        }
        if (!container) return null;

        const btnSels = [
            '.captcha-slider-btn', '.btn-slide', '[class*="slider-btn"]',
            '[class*="slide-btn"]', '[class*="slider"] button', '.btn_slide'
        ];
        let btn = null;
        for (const sel of btnSels) {
            const el = container.querySelector(sel);
            if (el && el.offsetParent !== null) { btn = el; break; }
        }
        if (!btn) return null;

        const cRect = container.getBoundingClientRect();
        const bRect = btn.getBoundingClientRect();
        return {
            sliderX: bRect.x + bRect.width / 2,
            sliderY: bRect.y + bRect.height / 2,
            containerWidth: cRect.width
        };
    });

    if (!info) throw new Error('Không tìm thấy slider');
    log(`  🎯 Slider @ (${Math.round(info.sliderX)},${Math.round(info.sliderY)}), container=${Math.round(info.containerWidth)}px`);
    return info;
}

// ============================================================
// MAIN
// ============================================================
export async function solveAliyunPuzzle(page, buffers, log, options = {}) {
    const { maxAttempts = 3, saveDebug = false } = options;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        log(`\n🔐 Giải captcha lần ${attempt}/${maxAttempts}`);

        try {
            if (saveDebug) {
                fs.writeFileSync(`debug-back-${attempt}.png`, buffers.back);
                fs.writeFileSync(`debug-shadow-${attempt}.png`, buffers.shadow);
            }

            const gap = await detectGap(buffers.back, log);
            const piece = await detectPiece(buffers.shadow, log);

            const rawOffset = Math.round(gap.minX - piece.minX);
            log(`  📐 Raw offset: ${rawOffset}px`);

            const slider = await findSlider(page, log);
            const scale = slider.containerWidth / 300;
            const realOffset = Math.round(rawOffset * scale);
            log(`  📐 Real offset: ${realOffset}px (scale ${scale.toFixed(2)})`);

            const track = generateTrajectory(realOffset);
            await replay(page, slider.sliderX, slider.sliderY, track, log);

            log('  ⏳ Chờ verify...');
            await sleep(3000);

            const result = await page.evaluate(() => {
                const errEl = document.querySelector('[class*="captcha-error"], [class*="error-msg"], .nc-lang-cnt');
                const container = document.querySelector(
                    '[class*="aliyun-captcha"], .nc-container, .captcha-container, .el-dialog:has(img[src*="back.png"])'
                );
                return {
                    error: errEl?.innerText || null,
                    containerVisible: container ? container.offsetParent !== null : false
                };
            });

            if (!result.containerVisible) {
                log('  🎉 CAPTCHA PASSED!');
                return { success: true, offset: realOffset, attempt };
            }

            log(`  ❌ Chưa pass${result.error ? ': ' + result.error : ''}`);

            if (attempt < maxAttempts) {
                log('  🔄 Refresh captcha...');
                await page.evaluate(() => {
                    const sels = ['.nc_iconfont.btn_refresh', '[class*="refresh"]',
                                  '.captcha-refresh', '[class*="reload"]'];
                    for (const sel of sels) {
                        const el = document.querySelector(sel);
                        if (el) { el.click(); return; }
                    }
                });
                await sleep(2500);
            }
        } catch (e) {
            log('  ❌ Lỗi: ' + e.message);
            if (attempt === maxAttempts) throw e;
            await sleep(2000);
        }
    }

    return { success: false, reason: 'max attempts' };
}
