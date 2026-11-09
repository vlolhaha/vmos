# TODO

## Đã xong

- [x] Sửa lỗi token OTP bị cache cũ trong `lib/inbox-store.js`.
- [x] Bỏ cảnh báo sai về package `t64` và WARP khi không bật.
- [x] Cải thiện tìm Chrome/Chromium và xử lý lỗi tạo token OTP không làm hỏng flow.
- [x] Thêm xử lý `EADDRINUSE`, `express.json`, chặn favicon.
- [x] Test lại VMOS end-to-end và push bản sửa lỗi OTP.
- [x] Dump DOM VSPhone bằng Chrome + Xvfb.
- [x] Test live đăng ký VSPhone: captcha, OTP, đăng ký, token phiên.
- [x] Viết thiết kế tích hợp trong `VSPhone_DESIGN.md`.

## Đang làm

- [x] Tích hợp VSPhone vào web UI (service selector).
- [x] Test tích hợp `runVsPhoneBot` qua UI.
- [x] Cập nhật kết quả và nhãn UI cho VSPhone.

## Tiếp theo

- [ ] LDCloud: hoàn thiện đăng ký + captcha OCR/manual fallback.
- [ ] BBCloud: chờ URL và mô tả flow đăng ký.
- [ ] Thêm regression test cho token OTP đọc chéo process.
