// Vercel Serverless Function: đồng bộ Sổ HLV ↔ Nhật Ký Tập.
// Lưu trữ: Upstash Redis qua REST (biến môi trường do Vercel Marketplace tự thêm).
// Không có tài khoản: HLV giữ "coachKey", học viên giữ "traineeKey" (sinh ngẫu nhiên trên máy),
// máy chủ chỉ lưu bản băm SHA-256 của khoá. Ghép đôi bằng mã 8 ký tự, hết hạn sau 7 ngày.
'use strict';
const crypto = require('node:crypto');

const STORE_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const STORE_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const CODE_TTL = 7 * 24 * 3600;
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
  async ping() { return { ok: true, store: Boolean(STORE_URL && STORE_TOKEN) }; },

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
    const coachName = str(b.coachName, 80), clientName = str(b.clientName, 80);
    if ((coachName && coachName !== meta.coachName) || (clientName && clientName !== meta.clientName)) {
      cmds.push(['SET', `pair:${b.pairId}`, JSON.stringify({ ...meta, coachName: coachName || meta.coachName, clientName: clientName || meta.clientName })]);
    }
    await store(...cmds);
    return { ok: true };
  },

  async 'coach-pull'(b) {
    const meta = await asCoach(b);
    const [results, profile] = await store(['GET', `pair:${b.pairId}:results`], ['GET', `pair:${b.pairId}:profile`]);
    return { claimed: Boolean(meta.traineeKeyHash), claimedAt: meta.claimedAt, results: (parse(results) || {}).items || [], profile: parse(profile) };
  },

  async 'trainee-pull'(b) {
    const meta = await asTrainee(b);
    const [plans] = await store(['GET', `pair:${b.pairId}:plans`]);
    return { plans: (parse(plans) || {}).plans || [], coachName: meta.coachName, clientName: meta.clientName };
  },

  async 'trainee-push'(b) {
    await asTrainee(b);
    const now = new Date().toISOString();
    const cmds = [['SET', `pair:${b.pairId}:results`, JSON.stringify({ items: arr(b.results, 150), at: now })]];
    if (b.profile && typeof b.profile === 'object') cmds.push(['SET', `pair:${b.pairId}:profile`, JSON.stringify({ ...b.profile, weights: arr(b.profile.weights, 200), at: now })]);
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
