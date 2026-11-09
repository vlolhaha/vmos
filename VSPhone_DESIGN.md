# VSPhone Cloud — Thiết kế tích hợp

## 1. Phạm vi

Thêm **VSPhone Cloud** thành dịch vụ thứ hai trong web UI hiện tại, bên cạnh VMOS.
Không thay đổi luồng VMOS đang chạy.

Kết quả mỗi account VSPhone:

```text
email|password|otp_token
```

Trong đó `otp_token` là token 24h của hòm thư, dùng cho tab **Nhận OTP**.
VSPhone hiện không có trial miễn phí và không có share link kiểu VMOS.

## 2. DOM dump

- Trang đăng nhập/đăng ký: `https://cloud.vsphone.com/login`
- Công cụ dump: Chrome 157 + `puppeteer-core`, chạy headful qua Xvfb `:99`.
- File dump tạm:
  - `/tmp/opencode/vsphone-login-dom.html`
  - `/tmp/opencode/vsphone-register-dom.html`
  - `/tmp/opencode/vsphone-login.png`
  - `/tmp/opencode/vsphone-register.png`
- DOM sau đăng ký có chứa token phiên nên không lưu vào repo.

### Selector chính

| Thành phần | Selector |
|---|---|
| Email | `input[placeholder="Please enter your email address"]` |
| Mã xác minh | `input[placeholder="Please enter the verification code"]` |
| Mật khẩu | `input[placeholder="Please enter your login password"]` |
| Mã mời | `input[placeholder="Please enter the invitation code"]` |
| Nút lấy mã | `#get-captcha-code` |
| Nút Login/Register | `button` có text `Login/Register` |
| Nút đăng ký | `button` có text `Register and log in` |
| Checkbox điều khoản | `.el-checkbox__original` |
| Ảnh captcha | `#aliyunCaptcha-img` |
| Mảnh ghép captcha | `#aliyunCaptcha-puzzle` |
| Slider captcha | `#aliyunCaptcha-sliding-slider` |

## 3. Luồng đăng ký

1. Tạo email tạm và token OTP 24h.
2. Mở Chromium, vào trang đăng nhập.
3. Nhập email.
4. Bấm **Login/Register** để chuyển sang form đăng ký.
5. Bấm **Get code**.
6. Giải captcha Aliyun dạng puzzle.
7. Chờ email OTP, nhập mã xác minh.
8. Tạo mật khẩu, tích điều khoản, bấm **Register and log in**.
9. Chờ trang chủ và đọc token phiên từ `localStorage`.
10. Trả kết quả về UI.

## 4. API quan sát được

Các request được ghi nhận trong lúc test:

| Method | Endpoint | Ghi chú |
|---|---|---|
| GET | `/vsphone/api/user/checkEmail?mobilePhone=...` | Kiểm tra email |
| POST | `/vsphone/api/sms/smsSend` | Gửi OTP; body có `smsType: 2`, `mobilePhone`, `captchaVerifyParam` |
| POST | `/vsphone/api/user/login` | Đăng ký/đăng nhập; body có `mobilePhone`, `loginType: 0`, `verifyCode`, `password` (MD5), `channel: "web"` |
| GET | `/vsphone/api/newUserBenefits/info` | Thông tin trial; lúc test trả `enabled: false`, `trialAvailable: false` |

Sau đăng ký, `localStorage` có:

```json
{
  "token": "...",
  "userId": "61952698",
  "users": "[{\"userId\":61952698,\"token\":\"...\"}]"
}
```

## 5. Captcha

- Aliyun Puzzle, `sceneId: 5jvar3wp`, mode `popup`.
- Ảnh `back.png` / `shadow.png` có cả trong DOM dạng data URL và request mạng.
- Dùng lại `lib/aliyun-captcha.js`.
- Cần chờ khoảng 6 giây cho POW/risk engine trước khi kéo slider.
- Nếu sai, captcha tự refresh; solver đọc ảnh mới từ network response.

## 6. Kiến trúc tích hợp

- `lib/vsphone-bot.js`: toàn bộ flow VSPhone, export `runVsPhoneBot`.
- `server.js`: nhận `config.service`, chọn `runBot` (VMOS) hoặc `runVsPhoneBot`.
- `public/index.html`: thêm select **Dịch vụ**.
- `public/app.js`:
  - gửi `service` khi bắt đầu;
  - đổi nhãn kết quả theo dịch vụ;
  - ẩn tab Share Link khi chọn VSPhone.
- `bot.js`: export `launchBrowser` để tái sử dụng, thêm `service: 'vmos'` vào result.

## 7. Kết quả trả về

```json
{
  "service": "vsphone",
  "email": "user@example.com",
  "password": "Vsphone@xxxxxxxx",
  "token": "otp-token-24h",
  "tokenExpiresAt": 1794300000000,
  "accountToken": "vsphone-session-token",
  "userId": "12345678",
  "provider": "inboxkitten",
  "loginUrl": "https://cloud.vsphone.com/login",
  "timestamp": "2026-11-09T11:06:00.000Z"
}
```

Dòng copy nhanh vẫn là `email|password|token` (token OTP), không phải token phiên VSPhone.

## 8. Kiểm thử

- Đã test live ngày 2026-11-09:
  - captcha pass lần 1;
  - nhận OTP 6 số;
  - đăng ký thành công;
  - đọc được `userId` và token phiên;
  - xác nhận `trialAvailable: false`.
- Đã test tích hợp `runVsPhoneBot` trực tiếp: đăng ký thành công, result đúng schema.
- Đã test qua UI tại `http://localhost:3001`:
  - chọn VSPhone ẩn tab Share Link;
  - chạy bot thành công;
  - kết quả hiển thị `Email VSPhone`, `Pass VSPhone`, `Token OTP`, `User ID`, `Token phiên VSPhone`;
  - không có lỗi console.
- Captcha có thể báo `Failed to load the captcha component` ở lần đầu; bot tự đóng popup và thử lại, lần 2 thành công.

## 9. Giới hạn

- Không có trial miễn phí tại thời điểm test.
- Không có share link.
- Chưa hỗ trợ đổi mật khẩu / quên mật khẩu cho VSPhone.
- Captcha phụ thuộc Aliyun risk engine; nếu IP bị đánh dấu có thể phải thử lại.
- Mỗi email chỉ đăng ký một lần; bot luôn tạo email mới.
