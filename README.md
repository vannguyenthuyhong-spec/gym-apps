# Gym apps

Bộ ứng dụng cho tập gym kèm 1-1 với PT HongCam CamFit.

| Thư mục | Nội dung |
|---|---|
| [`nhat-ky-tap/`](nhat-ky-tap/) | **Nhật Ký Tập Gym**: app cho người tập. Giáo án người mới, tự tập lại bài PT đã dạy, mẹo tư thế/hít thở/gồng core, gợi ý tăng tạ, nhật ký và tiến bộ. |
| [`coach-platform/mobile/`](coach-platform/mobile/) | **Sổ HLV 1-1**: app cho huấn luyện viên quản lý học viên, buổi tập, ảnh/video tiến bộ. |
| [`coach-platform/`](coach-platform/) | Thiết kế kiến trúc và backend (Node.js, Fastify, PostgreSQL, S3) cho nền tảng HLV. |

Hai app điện thoại là web tĩnh, không cần server. Thư mục `web/` trong mỗi app là bản để tải lên hosting; dữ liệu lưu trên chính điện thoại người dùng.

## Cập nhật app

Sửa mã nguồn (`nhat-ky-tap/nhat-ky-tap.html` hoặc `coach-platform/mobile/so-hlv.html`), rồi chạy trong PowerShell:

```powershell
.\cap-nhat.ps1 "Mô tả thay đổi"
```

Lệnh này build lại bản web, commit và push lên GitHub. Sau khoảng 1 phút:

- **Vercel:** https://camgym.vercel.app (project nối repo này, Root Directory = `nhat-ky-tap`) tự deploy bản mới.
- **GitHub Pages:** https://vannguyenthuyhong-spec.github.io/gym-apps/ cũng tự cập nhật.
