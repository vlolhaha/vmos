# ============================================================
# VMOS Auto — Node 20 + Chromium (tải qua @puppeteer/browsers)
# ============================================================
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    DISPLAY=:99 \
    XVFB_SCREEN=1280x900x24 \
    TZ=Asia/Ho_Chi_Minh \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/local/bin/chromium

# Cài đặt các thư viện hệ thống cần thiết cho Chromium và Xvfb
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11-utils \
    tini \
    ca-certificates \
    curl \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libasound2 \
    libpango-1.0-0 \
    libcairo2 \
    libxshmfence1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cài đặt dependencies của Node.js
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

# Tải Chromium chính thức qua @puppeteer/browsers (không phụ thuộc apt)
RUN npx @puppeteer/browsers install chromium@latest --path /usr/local/lib/chromium \
    && CHROME_PATH=$(find /usr/local/lib/chromium -name chrome -type f | head -n 1) \
    && ln -sf "$CHROME_PATH" /usr/local/bin/chromium \
    && /usr/local/bin/chromium --version

COPY . .

RUN chmod +x /app/entrypoint.sh 2>/dev/null || true \
 && chmod +x /app/docker/entrypoint.sh 2>/dev/null || true \
 && mkdir -p /app/data

EXPOSE 3000

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sh", "-c", "if [ -f /app/entrypoint.sh ]; then exec sh /app/entrypoint.sh; elif [ -f /app/docker/entrypoint.sh ]; then exec sh /app/docker/entrypoint.sh; else exec node /app/server.js; fi"]
