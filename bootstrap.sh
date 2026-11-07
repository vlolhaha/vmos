#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# Bootstrap cho máy trắng (Debian/Ubuntu VPS)
# Cài git/curl → clone repo → deploy.sh tự cài Docker + build
#
# Dùng:
#   curl -fsSL https://raw.githubusercontent.com/vlolhaha/vmos/master/bootstrap.sh | sudo bash
# ============================================================

REPO_URL="${VMOS_REPO_URL:-https://github.com/vlolhaha/vmos.git}"

if [ "$(id -u)" -eq 0 ]; then
    SUDO=()
    TARGET_DIR="${VMOS_DIR:-/opt/vmos}"
else
    if command -v sudo >/dev/null 2>&1; then
        SUDO=(sudo)
    else
        echo "❌ Cần quyền root hoặc sudo."
        exit 1
    fi
    TARGET_DIR="${VMOS_DIR:-$HOME/vmos}"
fi

echo "🚀 VMOS Auto bootstrap"
echo "📂 Thư mục cài: $TARGET_DIR"

# ============================================================
# Cài git + curl nếu thiếu
# ============================================================
if ! command -v git >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then
        echo "📦 Cài git + curl..."
        export DEBIAN_FRONTEND=noninteractive
        "${SUDO[@]}" apt-get update -y
        "${SUDO[@]}" apt-get install -y git curl ca-certificates
    else
        echo "❌ Cần git + curl. Cài thủ công rồi chạy lại."
        exit 1
    fi
fi

# ============================================================
# Clone / update repo
# ============================================================
if [ -d "$TARGET_DIR/.git" ]; then
    echo "📥 Repo đã có → cập nhật..."
    git -C "$TARGET_DIR" pull --ff-only
else
    echo "📥 Clone repo..."
    mkdir -p "$(dirname "$TARGET_DIR")"
    git clone "$REPO_URL" "$TARGET_DIR"
fi

cd "$TARGET_DIR"
chmod +x deploy.sh docker/entrypoint.sh

# ============================================================
# Deploy (deploy.sh tự cài Docker nếu chưa có)
# ============================================================
./deploy.sh
