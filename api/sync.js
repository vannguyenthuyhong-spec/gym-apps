// Vercel Serverless Function: đồng bộ Sổ HLV ↔ Nhật Ký Tập.
// Lưu trữ: Upstash Redis qua REST (biến môi trường do Vercel Marketplace tự thêm).
// Không có tài khoản: HLV giữ "coachKey", học viên giữ "traineeKey" (sinh ngẫu nhiên trên máy),
// máy chủ chỉ lưu bản băm SHA-256 của khoá. Ghép đôi bằng mã 8 ký tự, hết hạn sau 7 ngày.
'use strict';
const crypto = require('node:crypto');

const STORE_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const STORE_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const AI_KEY = process.env.ANTHROPIC_API_KEY;
const AI_MODEL = 'claude-opus-5-5';
const AI_PER_DAY = 30; // lượt AI ước lượng bữa ăn mỗi học viên mỗi ngày
const CODE_TTL = 7 * 24 * 3600;
const MEDIA_TTL = 21 * 24 * 3600; // ảnh/video nằm trên máy chủ tối đa 21 ngày (HLV tải về là xoá luôn)
const MAX_CHUNK = 520 * 1024; // ký tự base64 mỗi khúc
const MAX_CHUNKS = 48; // ~18 MB tệp gốc
const MAX_BODY = 900 * 1024;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // không có 0/O, 1/I dễ nhầm

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

async function store(...cmds) {
  const r = await fetch(`${STORE_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STORE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new HttpError(502, 'store_error', `Kho dữ liệu lỗi (${r.status})`);
  const out = await r.json();
  return out.map((x) => { if (x.error) throw new HttpError(502, 'store_error', x.error); return x.result; });
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const randHex = (n) => crypto.randomBytes(n).toString('hex');
const newCode = () => { let c = ''; for (const b of crypto.randomBytes(8)) c += ALPHABET[b % ALPHABET.length]; return `${c.slice(0, 4)}-${c.slice(4)}`; };
const normCode = (c) => { const s = String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : null; };
const isHex = (k, min = 32) => typeof k === 'string' && k.length >= min && k.length <= 128 && /^[a-f0-9]+$/.test(k);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
const isId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(v);
const small = (v, maxChars) => (v && typeof v === 'object' && JSON.stringify(v).length <= maxChars ? v : null);

// Mẹo/nhận xét HLV: object nhỏ; bữa ăn & danh mục ảnh: danh sách meta (không chứa ảnh)
function cleanMediaIndex(list) {
  return arr(list, 300).filter((m) => m && isId(m.id)).map((m) => ({
    id: m.id, kind: m.kind === 'video' ? 'video' : 'image', mime: str(m.mime, 40), size: Number(m.size) || 0,
    chunks: Math.min(MAX_CHUNKS, Number(m.chunks) || 0), date: str(m.date, 10), at: str(m.at, 30),
    ref: m.ref && typeof m.ref === 'object' ? { type: m.ref.type === 'meal' ? 'meal' : 'workout', id: str(m.ref.id, 64) } : null,
  }));
}

// ---------- AI ước lượng dinh dưỡng từ ảnh ----------
const MEAL_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['isFood', 'items', 'kcal', 'protein', 'carb', 'fat', 'comment'],
  properties: {
    isFood: { type: 'boolean' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'amount', 'kcal', 'protein', 'carb', 'fat'],
      properties: { name: { type: 'string' }, amount: { type: 'string' }, kcal: { type: 'number' }, protein: { type: 'number' }, carb: { type: 'number' }, fat: { type: 'number' } } } },
    kcal: { type: 'number' }, protein: { type: 'number' }, carb: { type: 'number' }, fat: { type: 'number' },
    comment: { type: 'string' },
  },
};
const MEAL_PROMPT = `Bạn ước lượng dinh dưỡng bữa ăn cho một người tập gym ở Việt Nam, từ ảnh chụp bằng điện thoại.
- Liệt kê từng món nhìn thấy (tên tiếng Việt), khẩu phần ước lượng (VD "1 chén cơm ~150 g"), kcal, đạm, tinh bột, chất béo (gam).
- Ưu tiên khẩu phần thường gặp ở quán/nhà tại Việt Nam. Không chắc thì chọn mức giữa, đừng phóng đại.
- kcal/protein/carb/fat ở ngoài là tổng của các món.
- comment: một câu ngắn tiếng Việt, gợi ý thực tế theo mục tiêu (VD thiếu đạm, nhiều dầu mỡ). Không phán xét.
- Nếu ảnh không phải đồ ăn/đồ uống: isFood=false, items rỗng, các số = 0.`;

async function estimateMeal(imageB64, mime, note, goal) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': AI_KEY, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    body: JSON.stringify({
      model: AI_MODEL, max_tokens: 4000,
      fallbacks: 'default', // bị từ chối do bộ lọc an toàn thì máy chủ Anthropic tự chạy lại bằng model dự phòng
      output_config: { effort: 'low', format: { type: 'json_schema', schema: MEAL_SCHEMA } },
      system: MEAL_PROMPT,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: imageB64 } },
        { type: 'text', text: `Mục tiêu của người tập: ${goal || 'không rõ'}.${note ? ` Ghi chú của người tập: ${note}` : ''}` },
      ] }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error('anthropic', r.status, j && j.error); throw new HttpError(502, 'ai_error', 'AI chưa trả lời được, thử lại sau.'); }
  if (j.stop_reason === 'refusal') throw new HttpError(422, 'ai_refused', 'AI không ước lượng được ảnh này. Hãy chọn khẩu phần bằng tay.');
  const text = (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const out = parse(text);
  if (!out) throw new HttpError(502, 'ai_error', 'AI trả kết quả không đọc được, thử lại.');
  const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 10) / 10 : 0);
  return { isFood: Boolean(out.isFood), kcal: n(out.kcal), protein: n(out.protein), carb: n(out.carb), fat: n(out.fat), comment: str(out.comment, 300),
    items: arr(out.items, 15).map((i) => ({ name: str(i.name, 80), amount: str(i.amount, 60), kcal: n(i.kcal), protein: n(i.protein), carb: n(i.carb), fat: n(i.fat) })) };
}

async function loadPair(pairId) {
  if (!isHex(pairId)) throw new HttpError(400, 'bad_request', 'pairId không hợp lệ');
  const [m] = await store(['GET', `pair:${pairId}`]);
  const meta = parse(m);
  if (!meta) throw new HttpError(404, 'not_found', 'Kết nối không tồn tại');
  return meta;
}
async function asCoach(b) {
  const meta = await loadPair(b.pairId);
  if (!isHex(b.coachKey) || sha(b.coachKey) !== meta.coachKeyHash) throw new HttpError(401, 'unauthorized', 'Sai khoá HLV');
  return meta;
}
async function asTrainee(b) {
  const meta = await loadPair(b.pairId);
  if (!meta.traineeKeyHash || !isHex(b.traineeKey) || sha(b.traineeKey) !== meta.traineeKeyHash) {
    throw new HttpError(401, 'unauthorized', 'Kết nối đã bị ngắt hoặc HLV đã tạo mã mới');
  }
  return meta;
}

const actions = {
  async ping() { return { ok: true, store: Boolean(STORE_URL && STORE_TOKEN), ai: Boolean(AI_KEY) }; },

  // HLV: tạo kết nối mới cho một học viên → mã để học viên nhập
  async 'pair-create'(b) {
    if (!isHex(b.coachKey)) throw new HttpError(400, 'bad_request', 'Thiếu khoá HLV');
    const pairId = randHex(16), code = newCode();
    const meta = { coachKeyHash: sha(b.coachKey), clientName: str(b.clientName, 80), coachName: str(b.coachName, 80), createdAt: new Date().toISOString(), traineeKeyHash: null, claimedAt: null };
    await store(['SET', `pair:${pairId}`, JSON.stringify(meta)], ['SET', `code:${code}`, pairId, 'EX', CODE_TTL]);
    return { pairId, code, expiresInDays: 7 };
  },

  // HLV: mã mới (học viên đổi máy). Học viên cũ sẽ bị ngắt khi mã mới được nhập.
  async 'pair-newcode'(b) {
    await asCoach(b);
    const code = newCode();
    await store(['SET', `code:${code}`, b.pairId, 'EX', CODE_TTL]);
    return { code, expiresInDays: 7 };
  },

  // Học viên: nhập mã
  async claim(b) {
    const code = normCode(b.code);
    if (!code) throw new HttpError(400, 'bad_code', 'Mã gồm 8 ký tự, ví dụ K7QP-3XMA');
    if (!isHex(b.traineeKey)) throw new HttpError(400, 'bad_request', 'Thiếu khoá học viên');
    const [pairId] = await store(['GET', `code:${code}`]);
    if (!pairId) throw new HttpError(404, 'bad_code', 'Mã không đúng hoặc đã hết hạn. Nhờ HLV tạo mã mới.');
    const meta = await loadPair(pairId);
    meta.traineeKeyHash = sha(b.traineeKey);
    meta.claimedAt = new Date().toISOString();
    await store(['SET', `pair:${pairId}`, JSON.stringify(meta)], ['DEL', `code:${code}`]);
    return { pairId, clientName: meta.clientName, coachName: meta.coachName };
  },

  async 'coach-push'(b) {
    const meta = await asCoach(b);
    const cmds = [['SET', `pair:${b.pairId}:plans`, JSON.stringify({ plans: arr(b.plans, 200), at: new Date().toISOString() })]];
    // Mẹo HLV: { global: {exId: [câu nhắc]}, personal: [{id, exId, text}] } · Nhận xét: { mealId|mediaId: text }
    const tips = small(b.tips, 120000), feedback = small(b.feedback, 120000);
    if (tips) cmds.push(['SET', `pair:${b.pairId}:tips`, JSON.stringify(tips)]);
    if (feedback) cmds.push(['SET', `pair:${b.pairId}:feedback`, JSON.stringify(feedback)]);
    const coachName = str(b.coachName, 80), clientName = str(b.clientName, 80);
    if ((coachName && coachName !== meta.coachName) || (clientName && clientName !== meta.clientName)) {
      cmds.push(['SET', `pair:${b.pairId}`, JSON.stringify({ ...meta, coachName: coachName || meta.coachName, clientName: clientName || meta.clientName })]);
    }
    await store(...cmds);
    return { ok: true };
  },

  async 'coach-pull'(b) {
    const meta = await asCoach(b);
    const [results, profile, meals, media] = await store(['GET', `pair:${b.pairId}:results`], ['GET', `pair:${b.pairId}:profile`],
      ['GET', `pair:${b.pairId}:meals`], ['GET', `pair:${b.pairId}:media`]);
    return { claimed: Boolean(meta.traineeKeyHash), claimedAt: meta.claimedAt, results: (parse(results) || {}).items || [], profile: parse(profile),
      meals: (parse(meals) || {}).items || [], media: (parse(media) || {}).items || [] };
  },

  // HLV tải một khúc ảnh/video học viên gửi
  async 'media-get'(b) {
    await asCoach(b);
    if (!isId(b.id) || !Number.isInteger(b.idx) || b.idx < 0 || b.idx >= MAX_CHUNKS) throw new HttpError(400, 'bad_request', 'Tệp không hợp lệ');
    const [data] = await store(['GET', `media:${b.pairId}:${b.id}:${b.idx}`]);
    if (!data) throw new HttpError(404, 'not_found', 'Tệp đã hết hạn trên máy chủ');
    return { data };
  },
  // HLV đã lưu tệp vào máy → xoá khỏi máy chủ cho nhẹ
  async 'media-ack'(b) {
    await asCoach(b);
    if (!isId(b.id)) throw new HttpError(400, 'bad_request', 'Tệp không hợp lệ');
    const n = Math.min(MAX_CHUNKS, Number(b.chunks) || 0);
    if (n) await store(...Array.from({ length: n }, (_, i) => ['DEL', `media:${b.pairId}:${b.id}:${i}`]));
    return { ok: true };
  },

  async 'trainee-pull'(b) {
    const meta = await asTrainee(b);
    const [plans, tips, feedback] = await store(['GET', `pair:${b.pairId}:plans`], ['GET', `pair:${b.pairId}:tips`], ['GET', `pair:${b.pairId}:feedback`]);
    return { plans: (parse(plans) || {}).plans || [], coachName: meta.coachName, clientName: meta.clientName, tips: parse(tips), feedback: parse(feedback) || {} };
  },

  // Học viên gửi một khúc ảnh/video (base64)
  async 'media-put'(b) {
    await asTrainee(b);
    if (!isId(b.id) || !Number.isInteger(b.idx) || !Number.isInteger(b.total) || b.total < 1 || b.total > MAX_CHUNKS || b.idx < 0 || b.idx >= b.total) {
      throw new HttpError(400, 'bad_request', 'Tệp quá lớn hoặc không hợp lệ');
    }
    if (typeof b.data !== 'string' || !b.data.length || b.data.length > MAX_CHUNK || !/^[A-Za-z0-9+/=]+$/.test(b.data)) throw new HttpError(400, 'bad_request', 'Dữ liệu tệp không hợp lệ');
    await store(['SET', `media:${b.pairId}:${b.id}:${b.idx}`, b.data, 'EX', MEDIA_TTL]);
    return { ok: true };
  },

  // Học viên: AI ước lượng dinh dưỡng từ ảnh bữa ăn
  async 'meal-ai'(b) {
    await asTrainee(b);
    if (!AI_KEY) throw new HttpError(503, 'ai_missing', 'HLV chưa bật AI ước lượng. Hãy chọn khẩu phần bằng tay.');
    const mime = ['image/jpeg', 'image/png', 'image/webp'].includes(b.mime) ? b.mime : 'image/jpeg';
    if (typeof b.image !== 'string' || b.image.length > 700 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(b.image)) throw new HttpError(400, 'bad_request', 'Ảnh không hợp lệ');
    const day = new Date().toISOString().slice(0, 10);
    const [count] = await store(['INCR', `ai:${b.pairId}:${day}`], ['EXPIRE', `ai:${b.pairId}:${day}`, 2 * 24 * 3600]);
    if (count > AI_PER_DAY) throw new HttpError(429, 'ai_limit', `Hôm nay đã dùng AI ${AI_PER_DAY} lần. Hãy chọn khẩu phần bằng tay.`);
    return estimateMeal(b.image, mime, str(b.note, 300), str(b.goal, 80));
  },

  async 'trainee-push'(b) {
    await asTrainee(b);
    const now = new Date().toISOString();
    const cmds = [['SET', `pair:${b.pairId}:results`, JSON.stringify({ items: arr(b.results, 150), at: now })]];
    if (b.profile && typeof b.profile === 'object') cmds.push(['SET', `pair:${b.pairId}:profile`, JSON.stringify({ ...b.profile, weights: arr(b.profile.weights, 200), at: now })]);
    if (Array.isArray(b.meals)) cmds.push(['SET', `pair:${b.pairId}:meals`, JSON.stringify({ items: arr(b.meals, 200), at: now })]);
    if (Array.isArray(b.media)) cmds.push(['SET', `pair:${b.pairId}:media`, JSON.stringify({ items: cleanMediaIndex(b.media), at: now })]);
    await store(...cmds);
    return { ok: true };
  },

  async unlink(b) {
    const meta = await asTrainee(b);
    meta.traineeKeyHash = null;
    await store(['SET', `pair:${b.pairId}`, JSON.stringify(meta)]);
    return { ok: true };
  },
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)); };

  if (req.method === 'OPTIONS') return send(204, {});
  if (req.method !== 'POST') return send(405, { error: 'method_not_allowed', message: 'Dùng POST' });

  try {
    let b = req.body;
    if (typeof b === 'string') b = parse(b);
    if (!b || typeof b !== 'object') throw new HttpError(400, 'bad_request', 'Body phải là JSON');
    if (JSON.stringify(b).length > MAX_BODY) throw new HttpError(413, 'too_large', 'Dữ liệu quá lớn');
    const fn = actions[b.action];
    if (!fn) throw new HttpError(400, 'bad_request', 'action không hợp lệ');
    if (b.action !== 'ping' && !(STORE_URL && STORE_TOKEN)) {
      throw new HttpError(503, 'store_missing', 'Chưa bật kho dữ liệu (Upstash Redis) trên Vercel');
    }
    return send(200, await fn(b));
  } catch (e) {
    if (e instanceof HttpError) return send(e.status, { error: e.code, message: e.message });
    console.error(e);
    return send(500, { error: 'internal', message: 'Lỗi máy chủ' });
  }
};
