# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim

# Môi trường mặc định — có thể override khi chạy container
ENV NODE_ENV=production \
    PORT=3000 \
    DISPLAY=:99 \
    XVFB_SCREEN=1280x900x24 \
    BROWSER_PATH=/usr/bin/chromium \
    WARP_ENABLED=false \
    TZ=Asia/Ho_Chi_Minh

# Chromium + Xvfb + fonts + các lib Chromium cần
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        xvfb \
        xauth \
        tini \
        ca-certificates \
        fonts-liberation \
        fonts-noto-color-emoji \
        fonts-noto-cjk \
        libasound2 \
        libatk-bridge2.0-0 \
        libgbm1 \
        libnss3 \
        libxkbcommon0 \
        libxdamage1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Cài dependencies trước để tận dụng Docker layer cache
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

COPY --chown=node:node . .
RUN chmod +x /app/docker/entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R node:node /app

USER node

EXPOSE 3000
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
