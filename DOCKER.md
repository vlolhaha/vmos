# Deploy VMOS Auto bằng Docker

Image đã gồm đầy đủ **Node.js + Chromium + Xvfb + fonts**, không cần cài gì thêm trên server.

## 1. Deploy nhanh

### Máy trắng (VPS Debian/Ubuntu mới, chỉ cần internet + root/sudo)

Một lệnh duy nhất — tự cài git/curl, clone repo, tự cài Docker nếu chưa có, build và chạy:

```bash
curl -fsSL https://raw.githubusercontent.com/vlolhaha/vmos/master/bootstrap.sh | sudo bash
```

Mặc định cài vào `/opt/vmos`. Đổi thư mục:

```bash
curl -fsSL https://raw.githubusercontent.com/vlolhaha/vmos/master/bootstrap.sh | sudo VMOS_DIR=/srv/vmos bash
```

Sau khi xong, mở: `http://IP-SERVER:3000`

### Máy đã có sẵn source code

```bash
chmod +x deploy.sh
./deploy.sh
```

`deploy.sh` sẽ tự cài Docker/Docker Compose nếu thiếu (Debian/Ubuntu, cần root/sudo).

Hoặc dùng Compose trực tiếp:

```bash
docker compose up -d --build
```

Mở UI: `http://IP-SERVER:3000`

## 2. Lệnh thường dùng

```bash
docker compose logs -f vmos     # xem log
docker compose restart vmos     # restart
docker compose down             # dừng (giữ volume data)
docker compose up -d --build    # update code rồi deploy lại
```

## 3. Dữ liệu token OTP

Token OTP 24h được lưu trong volume `vmos-data` → restart/update container **không mất token**.

```bash
docker volume inspect vmos-data
```

Muốn xóa sạch token:

```bash
docker compose down -v
```

## 4. Cấu hình

Compose đọc các biến từ `.env` (nếu có):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3000` | Port UI + API |
| `BROWSER_PATH` | `/usr/bin/chromium` | Chromium trong image |
| `WARP_ENABLED` | `false` | Bật WARP trên host nếu có |
| `XVFB_SCREEN` | `1280x900x24` | Độ phân giải Xvfb |
| `TZ` | `Asia/Ho_Chi_Minh` | Múi giờ log/token |
| `VMOS_DEBUG` | `0` | Log request debug |

Ví dụ đổi port:

```bash
PORT=8080 docker compose up -d --build
```

## 5. Fallback đã tích hợp

- **Docker**: `deploy.sh` tự cài nếu chưa có (Debian/Ubuntu), tự dùng `sudo` khi user chưa thuộc group docker.
- **Xvfb**: entrypoint tự start; nếu lỗi, app tự thử start tiếp; không có Xvfb thì app vẫn chạy.
- **Chromium**: tìm `BROWSER_PATH` → env → `/usr/bin/chromium` → Chrome.
- **WARP**: nếu bật mà container không dùng được WARP, bot tự fallback về IP gốc và tiếp tục chạy.
- **Token OTP**: lưu file bền vững trong volume, tự dọn token hết hạn.
- **Container**: `restart: unless-stopped`, healthcheck 30s, log giới hạn 10MB × 3.

> Yêu cầu máy trắng: có internet để tải base image/apt/npm. Nếu dùng distro khác Debian/Ubuntu, cài Docker thủ công trước rồi chạy `./deploy.sh`.
>
> WARP client không được cài trong container (cần systemd/NET_ADMIN và không ổn định trong Docker).
> Nếu cần đổi IP, dùng VPN/proxy ở host hoặc để `WARP_ENABLED=false`.

## 6. Bảo mật

UI **không có đăng nhập**. Chỉ nên mở port trong mạng riêng, hoặc đặt sau reverse proxy có Basic Auth/Cloudflare Access. Không nên public trực tiếp ra Internet.
