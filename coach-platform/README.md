# CoachTrack

Backend cho HLV quản lý học viên theo ngày: giao bài, học viên ghi set + upload ảnh/video, HLV phản hồi, theo dõi tiến bộ.
Thiết kế chi tiết: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Stack:** Node 22 · Fastify 4 · TypeScript · Zod · Prisma/PostgreSQL 16 · Redis/BullMQ · S3/MinIO · sharp + ffmpeg.

## Chạy nhanh (Docker)

```bash
cp .env.example .env
docker compose up --build
```

Dữ liệu demo (tuỳ chọn): chạy `npm run seed` trong `apps/api` từ máy local, với `DATABASE_URL` trỏ vào Postgres của compose (cổng 5432).

- API: http://localhost:3000/api/v1 — OpenAPI UI: http://localhost:3000/docs
- MinIO console: http://localhost:9001 (minioadmin / minioadmin)

## Phát triển local

```bash
cd apps/api
npm install
npx prisma migrate dev        # tạo DB từ schema
npm run seed                  # dữ liệu demo (coach@example.test / trainee@example.test)
npm run dev                   # API
npm run dev:worker            # worker (cần ffmpeg trong PATH)
npm run typecheck && npm test
```

## Luồng upload video từ app (tóm tắt)

```ts
// 1. Khởi tạo
const init = await api.post('/media/uploads', { mimeType: 'video/mp4', sizeBytes: file.size });

if (init.mode === 'single') {
  await fetch(init.uploadUrl, { method: 'PUT', headers: init.headers, body: file });
  await api.post(`/media/${init.mediaId}/complete`, {});
} else {
  // 2. Multipart: xin URL cho từng part, upload song song (3–4 luồng), retry riêng part lỗi
  const nums = Array.from({ length: init.partCount }, (_, i) => i + 1);
  const { parts } = await api.post(`/media/${init.mediaId}/parts`, { partNumbers: nums });
  const done = await Promise.all(parts.map(async ({ partNumber, url }) => {
    const blob = file.slice((partNumber - 1) * init.partSize, partNumber * init.partSize);
    const res = await fetch(url, { method: 'PUT', body: blob });
    return { partNumber, etag: res.headers.get('ETag')! };
  }));
  await api.post(`/media/${init.mediaId}/complete`, { parts: done });
}

// 3. Ghi set + gắn video (không cần chờ transcode xong)
await api.put(`/assignment-items/${itemId}/logs`, {
  sets: [{ setIndex: 1, reps: 5, weightKg: 80, rpe: 8 }],
  mediaIds: [init.mediaId],
});
```

> Bucket S3 cần CORS cho phép `PUT` từ domain web và expose header `ETag`.

## Cấu trúc

```
apps/api/
  prisma/schema.prisma, migrations/   Database schema + migration khởi tạo
  src/config        biến môi trường (validate khi khởi động)
  src/lib           storage S3, queue, phân quyền, outbox, phân trang
  src/plugins       JWT auth, error handler
  src/modules       auth · trainees · exercises · assignments · tracking · media · progress · health
  src/workers       xử lý media (sharp/ffmpeg), dọn upload treo, outbox relay
```
