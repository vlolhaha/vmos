import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'inbox-tokens.json');

// Token OTP chỉ tồn tại đúng 1 ngày trên server
export const INBOX_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

let cache = null;

function load() {
    if (cache) return cache;
    try {
        const raw = fs.readFileSync(STORE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        cache = parsed && typeof parsed === 'object' && parsed.tokens && typeof parsed.tokens === 'object'
            ? parsed
            : { version: 1, tokens: {} };
    } catch {
        cache = { version: 1, tokens: {} };
    }
    return cache;
}

function save(store) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STORE_FILE);
}

function purgeExpired(store) {
    const now = Date.now();
    let changed = false;
    for (const [token, entry] of Object.entries(store.tokens)) {
        if (!entry || !entry.expiresAt || entry.expiresAt <= now) {
            delete store.tokens[token];
            changed = true;
        }
    }
    if (changed) {
        try { save(store); } catch {}
    }
    return changed;
}

/**
 * Tạo token 24h để mở lại hòm thư OTP của tài khoản.
 * `mail.session` do lib/mailtm.js tạo ra, chứa đủ thông tin đăng nhập provider.
 */
export function createInboxToken(mail) {
    if (!mail?.session?.provider) {
        throw new Error('Mail provider không hỗ trợ tạo token OTP (thiếu session)');
    }

    const store = load();
    purgeExpired(store);

    let token;
    do {
        token = randomBytes(18).toString('base64url');
    } while (store.tokens[token]);

    const createdAt = Date.now();
    const expiresAt = createdAt + INBOX_TOKEN_TTL_MS;

    store.tokens[token] = {
        createdAt,
        expiresAt,
        session: mail.session
    };
    save(store);

    mail.inboxToken = token;
    return { token, expiresAt };
}

/**
 * Trả về { session, createdAt, expiresAt } hoặc null nếu token sai/hết hạn.
 */
export function getInboxToken(token) {
    if (!token || typeof token !== 'string') return null;

    const store = load();
    purgeExpired(store);

    const entry = store.tokens[token];
    if (!entry) return null;
    if (!entry.expiresAt || entry.expiresAt <= Date.now()) {
        delete store.tokens[token];
        try { save(store); } catch {}
        return null;
    }

    return {
        session: entry.session,
        createdAt: entry.createdAt,
        expiresAt: entry.expiresAt
    };
}

export function revokeInboxToken(token) {
    const store = load();
    if (!store.tokens[token]) return false;
    delete store.tokens[token];
    try { save(store); } catch {}
    return true;
}

export function purgeExpiredInboxTokens() {
    return purgeExpired(load());
}
