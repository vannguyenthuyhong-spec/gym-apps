# Sổ HLV 1-1 — app điện thoại

App web cho HLV kèm 1-1, dùng trên điện thoại:

- **Hôm nay:** buổi tập trong ngày, đánh dấu "đã tập" một chạm, các buổi quá hạn cần cập nhật, học viên chưa có lịch (nút *Lặp buổi trước*).
- **Học viên:** lịch tập (set × reps @ kg, tick từng bài), đánh giá buổi 1–5, ghi chú HLV, ảnh/video.
- **Tiến bộ:** số buổi đã tập, % hoàn thành 30 ngày, biểu đồ cân nặng, kỷ lục tạ theo từng bài, lịch sử chỉ số (cân nặng, vòng eo, % mỡ).
- **Ảnh/Video:** so sánh ảnh đầu tiên và ảnh gần nhất, thư viện theo ngày.

## Tệp

| Tệp | Vai trò |
|---|---|
| `so-hlv.html` | Mã nguồn duy nhất của app |
| `build-web.mjs` | Tạo bản web tĩnh vào `web/` (thêm manifest, icon, service worker) |
| `web/` | Thư mục deploy lên Vercel |
| `serve.mjs` | Server thử nghiệm trên máy: `node serve.mjs` rồi mở http://localhost:4173 |

Sửa `so-hlv.html` xong thì chạy lại:

```bash
node build-web.mjs
```

## Tự tải lên hosting (không cần dòng lệnh)

Dùng tệp **`so-hlv-web.zip`** (hoặc nội dung thư mục `web/`). Đường dẫn bên trong là tương đối, nên đặt ở gốc tên miền hay thư mục con đều chạy.

- **Netlify Drop:** vào app.netlify.com/drop, kéo thả thư mục `web` (đã giải nén) vào trang. Có link ngay.
- **Vercel:** vercel.com → Add New → Project → tải thư mục lên (hoặc import từ GitHub, Root Directory = thư mục chứa `index.html`).
- **GitHub Pages:** tạo repo, tải 5 tệp trong `web/` lên, rồi Settings → Pages → chọn nhánh `main`.
- **Hosting riêng (cPanel…):** giải nén zip vào `public_html` hoặc một thư mục con.

Cần **HTTPS** để cài app lên màn hình chính và chạy offline (các dịch vụ trên đều có sẵn).

## Deploy bằng Vercel CLI

Cần tài khoản Vercel:

```bash
npm i -g vercel
```

```bash
cd web
vercel --prod
```

Lần đầu CLI hỏi đăng nhập và tên project; sau đó trả về link dạng `https://so-hlv-xxx.vercel.app`.

Cách 2 — GitHub: đẩy thư mục này lên một repo, vào vercel.com → Add New → Project → chọn repo, đặt **Root Directory = `mobile/web`**, Framework = *Other*, không cần build command.

## Cài lên điện thoại

Mở link Vercel bằng **Safari (iPhone)** → nút Chia sẻ → *Thêm vào MH chính*; hoặc **Chrome (Android)** → ⋮ → *Thêm vào màn hình chính*. App mở toàn màn hình như app thật và vẫn mở được khi mất mạng.

## Dữ liệu lưu ở đâu

- **Bản Vercel:** mọi dữ liệu và ảnh/video nằm **trên chính điện thoại đó** (IndexedDB), không gửi lên server nào. Đổi máy hoặc xoá dữ liệu trình duyệt sẽ mất, nên hãy vào *Học viên → Sao lưu → Tải tệp sao lưu* mỗi tuần. Tệp sao lưu chứa học viên, buổi tập, chỉ số, nhưng **không gồm ảnh/video**.
- Ảnh được nén còn khoảng 1600px; video tối đa 150 MB mỗi tệp.
- Cùng tệp `so-hlv.html` khi publish thành artifact trên claude.ai sẽ tự chuyển sang lưu trên cloud (đồng bộ nhiều máy, video tối đa 20 MB).
- Muốn đồng bộ nhiều HLV / nhiều máy với server riêng: nối app vào backend trong `apps/api`.
