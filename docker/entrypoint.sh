#!/bin/sh
set -eu

export DISPLAY="${DISPLAY:-:99}"
SCREEN="${XVFB_SCREEN:-1280x900x24}"

# ":99" -> 99, ":99.0" -> 99
DISPLAY_NUM="${DISPLAY#*:}"
DISPLAY_NUM="${DISPLAY_NUM%%.*}"
SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"

XVFB_PID=""
STARTED_XVFB=0

cleanup() {
    if [ "$STARTED_XVFB" = "1" ] && [ -n "$XVFB_PID" ] && kill -0 "$XVFB_PID" 2>/dev/null; then
        kill "$XVFB_PID" 2>/dev/null || true
        wait "$XVFB_PID" 2>/dev/null || true
    fi
    if [ "$STARTED_XVFB" = "1" ]; then
        rm -f "$SOCKET" "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null || true
    fi
}

term() {
    cleanup
    exit 0
}

trap term INT TERM

# Kiểm tra display thật sự sống (tránh socket/lock cũ sau khi container restart)
DISPLAY_OK=0
if command -v xdpyinfo >/dev/null 2>&1; then
    if timeout 2 xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
        DISPLAY_OK=1
    fi
elif [ -S "$SOCKET" ]; then
    DISPLAY_OK=1
fi

# Fallback 1: dùng display có sẵn
if [ "$DISPLAY_OK" = "1" ]; then
    echo "✓ Dùng X display có sẵn: $DISPLAY"

# Fallback 2: tự start Xvfb
elif command -v Xvfb >/dev/null 2>&1; then
    echo "🚀 Khởi động Xvfb $DISPLAY ($SCREEN)..."
    mkdir -p /tmp/.X11-unix 2>/dev/null || true
    # Dọn socket/lock chết còn sót lại từ lần chạy trước
    rm -f "$SOCKET" "/tmp/.X${DISPLAY_NUM}-lock" 2>/dev/null || true
    Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp -ac >/tmp/xvfb.log 2>&1 &
    XVFB_PID=$!
    STARTED_XVFB=1

    i=0
    while [ ! -S "$SOCKET" ] && [ "$i" -lt 50 ]; do
        if ! kill -0 "$XVFB_PID" 2>/dev/null; then
            break
        fi
        i=$((i + 1))
        sleep 0.1
    done

    if [ -S "$SOCKET" ]; then
        echo "✓ Xvfb sẵn sàng: $DISPLAY"
    else
        echo "⚠️ Xvfb không khởi động được — app sẽ thử fallback..."
        cat /tmp/xvfb.log 2>/dev/null || true
        STARTED_XVFB=0
    fi

# Fallback 3: không có Xvfb → app vẫn chạy, bot tự xử lý/headless
else
    echo "⚠️ Không có Xvfb — app sẽ thử fallback hoặc chạy headless..."
fi

mkdir -p /app/data 2>/dev/null || true

# Chạy node như process con để còn cleanup Xvfb khi container dừng
node server.js &
APP_PID=$!

set +e
wait "$APP_PID"
STATUS=$?
set -e

cleanup
exit "$STATUS"
