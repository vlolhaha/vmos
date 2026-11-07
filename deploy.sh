#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# Nạp .env để lấy PORT/WARP_ENABLED... (nếu có)
if [ -f .env ]; then
    set -a
    # shellcheck disable=SC1091
    . ./.env
    set +a
fi

# ============================================================
# SUDO / ROOT
# ============================================================
if [ "$(id -u)" -eq 0 ]; then
    SUDO=()
else
    if command -v sudo >/dev/null 2>&1; then
        SUDO=(sudo)
    else
        SUDO=()
    fi
fi

need_root() {
    if [ "${#SUDO[@]}" -eq 0 ] && [ "$(id -u)" -ne 0 ]; then
        echo "❌ Cần quyền root hoặc sudo để $1."
        exit 1
    fi
}

# ============================================================
# TỰ CÀI DOCKER NẾU CHƯA CÓ (Debian/Ubuntu)
# ============================================================
install_docker() {
    if ! command -v apt-get >/dev/null 2>&1; then
        echo "❌ Chưa có Docker và không tự cài được trên distro này."
        echo "   Cài Docker thủ công: https://docs.docker.com/engine/install/"
        exit 1
    fi

    need_root "cài Docker"
    echo "📦 Chưa có Docker → tự cài đặt..."
    export DEBIAN_FRONTEND=noninteractive

    "${SUDO[@]}" apt-get update -y
    "${SUDO[@]}" apt-get install -y ca-certificates curl

    curl -fsSL https://get.docker.com | "${SUDO[@]}" sh

    if command -v systemctl >/dev/null 2>&1; then
        "${SUDO[@]}" systemctl enable --now docker >/dev/null 2>&1 || true
    fi
}

if ! command -v docker >/dev/null 2>&1; then
    install_docker
fi

# Nếu user chưa thuộc group docker → dùng sudo docker
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
    if [ "${#SUDO[@]}" -gt 0 ]; then
        "${SUDO[@]}" systemctl start docker >/dev/null 2>&1 || true
    fi
    if ! docker info >/dev/null 2>&1; then
        if [ "${#SUDO[@]}" -gt 0 ] && "${SUDO[@]}" docker info >/dev/null 2>&1; then
            DOCKER=("${SUDO[@]}" docker)
        else
            echo "❌ Không kết nối được Docker daemon."
            echo "   Thử: sudo systemctl start docker"
            echo "   Hoặc thêm user vào group docker: sudo usermod -aG docker \$USER"
            exit 1
        fi
    fi
fi

# ============================================================
# DOCKER COMPOSE
# ============================================================
COMPOSE=()

if "${DOCKER[@]}" compose version >/dev/null 2>&1; then
    COMPOSE=("${DOCKER[@]}" compose)
elif command -v docker-compose >/dev/null 2>&1; then
    if [ "${DOCKER[0]}" = "docker" ]; then
        COMPOSE=(docker-compose)
    else
        COMPOSE=("${SUDO[@]}" docker-compose)
    fi
else
    echo "📦 Thiếu Docker Compose → thử cài..."
    if command -v apt-get >/dev/null 2>&1; then
        need_root "cài Docker Compose"
        export DEBIAN_FRONTEND=noninteractive
        "${SUDO[@]}" apt-get install -y docker-compose-plugin >/dev/null 2>&1 || true
    fi

    if "${DOCKER[@]}" compose version >/dev/null 2>&1; then
        COMPOSE=("${DOCKER[@]}" compose)
    elif command -v docker-compose >/dev/null 2>&1; then
        if [ "${DOCKER[0]}" = "docker" ]; then
            COMPOSE=(docker-compose)
        else
            COMPOSE=("${SUDO[@]}" docker-compose)
        fi
    else
        echo "❌ Không cài được Docker Compose."
        exit 1
    fi
fi

# ============================================================
# DEPLOY
# ============================================================
echo "🐳 Build + deploy VMOS Auto..."
"${COMPOSE[@]}" up -d --build
"${COMPOSE[@]}" ps

PORT_VALUE="${PORT:-3000}"
echo ""
echo "✅ Deploy xong: http://localhost:${PORT_VALUE}"
echo "📜 Xem log:    ${COMPOSE[*]} logs -f vmos"
echo "🔄 Cập nhật:   git pull && ./deploy.sh"
