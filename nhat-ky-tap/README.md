# Nhật Ký Tập Gym

App web cho người tập, dùng trên điện thoại:

- **Tập theo giáo án người mới:** 2 giáo án có sẵn. *Toàn thân 3 buổi/tuần* ở phòng gym (A → B → C), hoặc *Tại nhà không dụng cụ* (A → B). App nhớ buổi tiếp theo.
- **Bài PT đã dạy:** sau mỗi buổi với PT, chọn các bài PT vừa dạy từ thư viện, ghi số hiệp × lần @ kg và lời dặn cho từng bài. Lần sau bấm *Tự tập lại buổi này*.
- **Trong lúc tập:** nhập kg/lần, tick từng hiệp; đồng hồ nghỉ tự chạy, có âm báo và rung. App gợi ý mức tạ dựa trên lần trước: làm đủ số lần ở mọi hiệp thì tăng tạ, chưa đủ thì giữ nguyên. Bấm tên bài để xem cách tập và lỗi hay gặp.
- **Nhật ký:** khi kết thúc buổi, chấm cảm giác 1–5 và ghi điều cần cải thiện. Có thêm ghi chú ngày: cân nặng, giấc ngủ, năng lượng.
- **Tiến bộ:** số buổi trong tháng, số tuần liên tiếp có tập, tổng tấn tạ đã nâng; biểu đồ sức mạnh theo từng bài, kỷ lục, 1RM ước tính, biểu đồ cân nặng, máy tính 1RM.
- **Thư viện:** 39 bài kèm hướng dẫn tiếng Việt, và thêm được bài riêng.

## Tệp

| Tệp | Vai trò |
|---|---|
| `nhat-ky-tap.html` | Mã nguồn của app |
| `build-web.mjs` | Tạo bản web tĩnh vào `web/` (manifest, icon, chạy offline) |
| `web/` và `nhat-ky-tap-web.zip` | Bản để tải lên hosting |
| `serve.mjs` | Chạy thử trên máy: `node serve.mjs` → http://localhost:4173 |
| `vercel.json` | Cấu hình Vercel: tự chạy `node build-web.mjs` và phát hành thư mục `web` (Root Directory = `nhat-ky-tap`) |

Sửa `nhat-ky-tap.html` xong thì chạy `node build-web.mjs`, rồi nén lại thư mục `web`.

## Tải lên

Giải nén zip rồi kéo thả thư mục vào app.netlify.com/drop. Cũng có thể đưa lên Vercel, GitHub Pages hoặc hosting riêng (cPanel). Trang cần **HTTPS**.

Mở link trên điện thoại rồi thêm vào màn hình chính:
- **iPhone:** Safari → Chia sẻ → *Thêm vào MH chính*
- **Android:** Chrome → ⋮ → *Thêm vào màn hình chính*

## Dữ liệu

Mọi thứ lưu trong trình duyệt của điện thoại đang dùng (localStorage), không gửi đi đâu. Vào ⚙ → *Tải tệp sao lưu* mỗi tuần và cất tệp lên Drive hoặc Zalo. Khi đổi máy, dùng *Khôi phục từ tệp*.

> Hướng dẫn trong app chỉ để tham khảo cho người mới. Nếu thấy đau nhói hoặc có bệnh nền, hãy hỏi PT hoặc bác sĩ.
