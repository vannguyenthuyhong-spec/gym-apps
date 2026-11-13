# Gym apps

Bộ ứng dụng cho tập gym kèm 1-1 với PT HongCam CamFit.

| Thư mục | Nội dung |
|---|---|
| [`nhat-ky-tap/`](nhat-ky-tap/) | **Nhật Ký Tập Gym**: app cho người tập. Giáo án người mới, tự tập lại bài PT đã dạy, mẹo tư thế/hít thở/gồng core, gợi ý tăng tạ, nhật ký và tiến bộ. |
| [`coach-platform/mobile/`](coach-platform/mobile/) | **Sổ HLV 1-1**: app cho huấn luyện viên quản lý học viên, buổi tập, ảnh/video tiến bộ. |
| [`coach-platform/`](coach-platform/) | Thiết kế kiến trúc và backend (Node.js, Fastify, PostgreSQL, S3) cho nền tảng HLV. |

Hai app điện thoại là web tĩnh; dữ liệu lưu trên chính điện thoại người dùng. Thư mục `web/` trong mỗi app là bản để tải lên hosting.

## Kết nối HLV ↔ học viên

[`api/sync.js`](api/sync.js) là hàm Vercel đồng bộ hai app qua kho **Upstash Redis** (gói miễn phí):

1. HLV: Sổ HLV → học viên → tab **Hồ sơ** → **Tạo mã kết nối** (mã 8 ký tự, dùng được 7 ngày).
2. Học viên: Nhật Ký Tập → **Kết nối với HLV** → nhập mã.
3. Từ đó:
   - Bài HLV lên lịch hiện ở mục **Bài HLV giao** trong app học viên.
   - Buổi học viên tập (kg, số lần, cảm giác, nhật ký), hồ sơ và cân nặng tự về Sổ HLV.

Lên buổi tập trong Sổ HLV có 3 cách:

- **Chọn từ thư viện**: cùng bộ bài với app học viên, lọc theo nhóm cơ, tìm không cần dấu, tab "Đã tập" cho bài học viên hay tập. Bài thêm từ thư viện tự điền mức tạ lần trước của học viên.
- **Dán giáo án**: dán đoạn tin nhắn kiểu `1. Hip Thrust — 3 set × 12 reps 10kg (nghỉ 2-3')`. App tự tách tên bài, hiệp, lần (cả khoảng 15–20), kg, thời gian nghỉ, "mỗi chân", ghi chú trong ngoặc. Dòng "Ngày 1: …" thành tên buổi, dòng "Khởi động: …" vào ghi chú; dòng cardio `10'` thành bài tính phút.
- **Tự nhập**: gõ tên bài riêng; app học viên sẽ tạo bài mới.

Bên app học viên, mỗi bài hiện mục tiêu, thời gian nghỉ (đồng hồ nghỉ chạy theo đúng thời gian HLV ghi) và lời dặn của HLV.

Hai app tự đồng bộ khi mở, khi lưu và định kỳ 1,5–2 phút; có nút "Đồng bộ" để chạy ngay. Không có tài khoản: mỗi bên giữ một khoá ngẫu nhiên trên máy, máy chủ chỉ lưu bản băm. Ảnh/video của Sổ HLV không đồng bộ.

**Bật kho dữ liệu (một lần):** Vercel → project → **Storage** → **Create Database** → **Upstash** → **Upstash for Redis** (Free) → Connect với project → Redeploy. Vercel tự thêm biến `KV_REST_API_URL` và `KV_REST_API_TOKEN`. Kiểm tra: `POST /api/sync {"action":"ping"}` trả `"store": true`.

## Cập nhật app

Sửa mã nguồn (`nhat-ky-tap/nhat-ky-tap.html` hoặc `coach-platform/mobile/so-hlv.html`), rồi chạy trong PowerShell:

```powershell
.\cap-nhat.ps1 "Mô tả thay đổi"
```

Lệnh này build lại bản web, commit và push lên GitHub. Sau khoảng 1 phút:

- **Vercel:** https://camgym.vercel.app tự deploy bản mới (project nối repo này, build theo `vercel.json` ở gốc). Trang `/` chuyển thẳng vào app Nhật Ký Tập; Sổ HLV ở `/coach-platform/mobile/web/`.
- **GitHub Pages:** https://vannguyenthuyhong-spec.github.io/gym-apps/ cũng tự cập nhật.
