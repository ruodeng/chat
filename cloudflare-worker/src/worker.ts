// Cloudflare Worker - File Share
// Uses KV for storage, supports file uploads via FormData

interface Env {
  ROOMS: KVNamespace;
  FILES: R2Bucket;
  TURNSTILE_SECRET_KEY: string;
  TURNSTILE_SITE_KEY: string;
}

interface Room {
  id: string;
  pin: string;
  ttlHours: number;
  createdAt: number;
  lastActivityAt: number;
  ipNames: Record<string, string>;
  messages: Message[];
}

interface Message {
  id: string;
  sender: string;
  type: 'text' | 'image' | 'file';
  text: string | null;
  fileName: string | null;
  r2Key: string | null;
  fileMime: string | null;
  fileSize: number | null;
  createdAt: number;
}

interface RoomIndexEntry {
  id: string;
  createdAt: number;
  lastActivityAt: number;
  ttlHours: number;
  participants: number;
  messageCount: number;
}

interface FailData {
  count: number;
  lastFail: number;
}

interface BlacklistEntry {
  until: number;
}

interface CreateTracker {
  timestamps: number[];
}

const TTL_OPTIONS: number[] = [1, 6, 12, 24];

const names: string[] = ['Alice', 'Bob', 'Charlie', 'David', 'Eve', 'Frank', 'Grace',
  'Henry', 'Iris', 'Jack', 'Kate', 'Leo', 'Mia', 'Noah', 'Olivia',
  'Peter', 'Quinn', 'Rose', 'Sam', 'Tina', 'Umar', 'Vera', 'Will',
  'Xena', 'Yuki', 'Zoe'];

// ============ Helpers ============
function genRoomId(): string {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789';
  const arr = new Uint8Array(6);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[arr[i] % chars.length];
  return s;
}
function genPin(): string {
  const arr = new Uint16Array(1);
  crypto.getRandomValues(arr);
  return String(1000 + (arr[0] % 9000));
}
function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') || request.headers.get('x-forwarded-for') || 'unknown';
}
function json(data: unknown, status: number = 200, extraHeaders?: Record<string, string>): Response {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  return new Response(JSON.stringify(data), { status, headers });
}
function parseAcceptLanguage(request: Request): string {
  const supported = ['zh', 'en', 'de', 'fr', 'ja', 'es'];
  const accept = request.headers.get('Accept-Language') || '';
  for (const part of accept.split(',')) {
    const lang = part.split(';')[0].trim().toLowerCase().split('-')[0];
    if (supported.includes(lang)) return lang;
  }
  return 'en';
}

// ============ KV Storage ============
// NOTE: KV uses last-writer-wins. Concurrent message sends from multiple
// users may cause one message to be silently overwritten. This is an
// acceptable tradeoff for the simplicity of KV-based storage.
async function getRoom(kv: KVNamespace, roomId: string): Promise<Room | null> {
  return await kv.get<Room>(`room:${roomId}`, 'json');
}
async function saveRoom(kv: KVNamespace, room: Room): Promise<void> {
  await kv.put(`room:${room.id}`, JSON.stringify(room), { expirationTtl: room.ttlHours * 3600 + 3600 });
}
async function deleteRoom(kv: KVNamespace, roomId: string): Promise<void> {
  await kv.delete(`room:${roomId}`);
}

// ============ Rate Limiting ============
async function getFailCount(kv: KVNamespace, ip: string, roomId: string): Promise<FailData> {
  const raw = await kv.get<FailData>(`fail:${ip}:${roomId}`, 'json');
  return raw || { count: 0, lastFail: 0 };
}
async function setFailCount(kv: KVNamespace, ip: string, roomId: string, data: FailData): Promise<void> {
  await kv.put(`fail:${ip}:${roomId}`, JSON.stringify(data), { expirationTtl: 3600 });
}
async function deleteFailCount(kv: KVNamespace, ip: string, roomId: string): Promise<void> {
  await kv.delete(`fail:${ip}:${roomId}`);
}
async function getBlacklist(kv: KVNamespace, ip: string): Promise<BlacklistEntry | null> {
  const raw = await kv.get<BlacklistEntry>(`blacklist:${ip}`, 'json');
  if (raw && Date.now() < raw.until) return raw;
  return null;
}
async function setBlacklist(kv: KVNamespace, ip: string, until: number): Promise<void> {
  await kv.put(`blacklist:${ip}`, JSON.stringify({ until }), { expirationTtl: Math.ceil((until - Date.now()) / 1000) + 60 });
}
async function getCreateTracker(kv: KVNamespace, ip: string): Promise<CreateTracker> {
  const raw = await kv.get<CreateTracker>(`create:${ip}`, 'json');
  return raw || { timestamps: [] };
}
async function setCreateTracker(kv: KVNamespace, ip: string, data: CreateTracker): Promise<void> {
  await kv.put(`create:${ip}`, JSON.stringify(data), { expirationTtl: 3600 });
}
async function getCreateBlacklist(kv: KVNamespace, ip: string): Promise<BlacklistEntry | null> {
  const raw = await kv.get<BlacklistEntry>(`create-bl:${ip}`, 'json');
  if (raw && Date.now() < raw.until) return raw;
  return null;
}
async function setCreateBlacklist(kv: KVNamespace, ip: string, until: number): Promise<void> {
  await kv.put(`create-bl:${ip}`, JSON.stringify({ until }), { expirationTtl: Math.ceil((until - Date.now()) / 1000) + 60 });
}

// ============ Name Assignment ============
function assignName(room: Room, ip: string): string {
  if (!room.ipNames) room.ipNames = {};
  if (room.ipNames[ip]) return room.ipNames[ip];
  const used = new Set(Object.values(room.ipNames));
  for (const n of names) {
    if (!used.has(n)) { room.ipNames[ip] = n; return n; }
  }
  const fallback = 'Guest' + (Object.keys(room.ipNames).length + 1);
  room.ipNames[ip] = fallback;
  return fallback;
}

// ============ Turnstile ============
async function verifyTurnstile(secret: string, token: string, ip: string): Promise<boolean> {
  if (!secret) return true;
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: ip });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
    const data: { success?: boolean } = await r.json() as { success?: boolean };
    return data.success === true;
  } catch { return false; }
}

// ============ Room Index ============
async function getRoomIndex(kv: KVNamespace): Promise<RoomIndexEntry[]> {
  const raw = await kv.get<RoomIndexEntry[]>('rooms:index', 'json');
  if (!raw) return [];
  const now = Date.now();
  return raw.filter(r => now - r.lastActivityAt < (r.ttlHours || 1) * 3600000);
}
async function addRoomToIndex(kv: KVNamespace, room: Room): Promise<void> {
  const index = await getRoomIndex(kv);
  index.push({ id: room.id, createdAt: room.createdAt, lastActivityAt: room.lastActivityAt, ttlHours: room.ttlHours, participants: Object.keys(room.ipNames || {}).length, messageCount: 0 });
  await kv.put('rooms:index', JSON.stringify(index), { expirationTtl: 90000 });
}
async function updateRoomInIndex(kv: KVNamespace, roomId: string, data: Partial<RoomIndexEntry>): Promise<void> {
  const index = await getRoomIndex(kv);
  const idx = index.findIndex(r => r.id === roomId);
  if (idx !== -1) { Object.assign(index[idx], data); await kv.put('rooms:index', JSON.stringify(index), { expirationTtl: 90000 }); }
}
async function removeRoomFromIndex(kv: KVNamespace, roomId: string): Promise<void> {
  const index = await getRoomIndex(kv);
  const filtered = index.filter(r => r.id !== roomId);
  await kv.put('rooms:index', JSON.stringify(filtered), { expirationTtl: 90000 });
}

// ============ R2 Cleanup ============
async function cleanupRoomFiles(bucket: R2Bucket, roomId: string): Promise<void> {
  const prefix = `room/${roomId}/`;
  let cursor: string | undefined = undefined;
  do {
    const listed = await bucket.list({ prefix, cursor, limit: 1000 });
    if (listed.objects.length) {
      await Promise.allSettled(listed.objects.map(obj => bucket.delete(obj.key)));
    }
    if (!listed.truncated) break;
    cursor = listed.cursor;
  } while (cursor);
}

// ============ Routes ============
function addCorsHeaders(response: Response, request: Request): Response {
  const origin = request.headers.get('Origin') || '';
  let isAllowed = origin === 'https://10086.review';
  if (!isAllowed && origin) {
    try { isAllowed = new URL(origin).hostname === 'localhost'; } catch { /* invalid origin */ }
  }
  const allowed = isAllowed ? origin : 'https://10086.review';
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowed);
  headers.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type,X-Room-Pin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const ip = clientIp(request);
  const kv = env.ROOMS;
  const turnstileSecret = env.TURNSTILE_SECRET_KEY || '';
  const turnstileSiteKey = env.TURNSTILE_SITE_KEY || '';

  // CORS preflight for API
  if (path.startsWith('/api/') && method === 'OPTIONS') {
    const origin = request.headers.get('Origin') || '';
    let isAllowed = origin === 'https://10086.review';
    if (!isAllowed && origin) {
      try { isAllowed = new URL(origin).hostname === 'localhost'; } catch { /* invalid origin */ }
    }
    const allowed = isAllowed ? origin : 'https://10086.review';
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': allowed, 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,X-Room-Pin' } });
  }

  // ============ API Routes ============

  // Turnstile config
  if (path === '/api/turnstile/config' && method === 'GET') {
    return json({ enabled: !!turnstileSiteKey, siteKey: turnstileSiteKey });
  }

  // List rooms
  if (path === '/api/rooms' && method === 'GET') {
    const index = await getRoomIndex(kv);
    return json(index);
  }

  // Create room
  if (path === '/api/room/create' && method === 'POST') {
    return await handleCreateRoom(request, ip, kv, turnstileSecret, turnstileSiteKey);
  }

  // Join room
  const joinMatch = path.match(/^\/api\/room\/([a-z0-9]+)\/join$/);
  if (joinMatch && method === 'POST') {
    return await handleJoinRoom(request, joinMatch[1], ip, kv, turnstileSecret, turnstileSiteKey);
  }

  // Room info
  const infoMatch = path.match(/^\/api\/room\/([a-z0-9]+)\/info$/);
  if (infoMatch && method === 'GET') {
    const room = await getRoom(kv, infoMatch[1]);
    if (!room) return json({ error: 'Room not found or expired', errorCode: 'ROOM_NOT_FOUND' }, 404);
    const senders = new Set((room.messages || []).map(m => m.sender));
    return json({
      roomId: room.id,
      createdAt: room.createdAt,
      lastActivityAt: room.lastActivityAt,
      ttlHours: room.ttlHours || 1,
      online: senders.size,
      messageCount: (room.messages || []).length,
    });
  }

  // Send message
  const sendMatch = path.match(/^\/api\/room\/([a-z0-9]+)\/send$/);
  if (sendMatch && method === 'POST') {
    return await handleSendMessage(request, sendMatch[1], ip, kv, env.FILES);
  }

  // Delete message
  const delMsgMatch = path.match(/^\/api\/room\/([a-z0-9]+)\/message\/([a-f0-9-]+)$/);
  if (delMsgMatch && method === 'DELETE') {
    return await handleDeleteMessage(request, delMsgMatch[1], delMsgMatch[2], ip, kv, env.FILES);
  }

  // Get messages
  const msgMatch = path.match(/^\/api\/room\/([a-z0-9]+)\/messages$/);
  if (msgMatch && method === 'GET') {
    const room = await getRoom(kv, msgMatch[1]);
    if (!room) return json({ error: 'Room not found or expired', errorCode: 'ROOM_NOT_FOUND' }, 404);
    const pin = request.headers.get('X-Room-Pin');
    if (pin !== room.pin) return json({ error: 'Wrong PIN', errorCode: 'WRONG_PIN' }, 403);
    const since = parseInt(url.searchParams.get('since') || '0') || 0;
    const filtered = (room.messages || []).filter(m => m.createdAt > since);
    return json({
      messages: filtered.map(m => ({
        id: m.id, sender: m.sender, type: m.type, text: m.text,
        fileName: m.fileName, fileSize: m.fileSize, hasFile: !!m.r2Key,
        createdAt: m.createdAt,
      })),
      lastActivityAt: room.lastActivityAt,
      ttlHours: room.ttlHours,
    });
  }

  // Download file
  const fileMatch = path.match(/^\/api\/room\/([a-z0-9]+)\/file\/([a-f0-9-]+)$/);
  if (fileMatch && method === 'GET') {
    const room = await getRoom(kv, fileMatch[1]);
    if (!room) return json({ error: 'Room not found or expired', errorCode: 'ROOM_NOT_FOUND' }, 404);
    const pin = request.headers.get('X-Room-Pin');
    if (pin !== room.pin) return json({ error: 'Wrong PIN', errorCode: 'WRONG_PIN' }, 403);
    const msg = (room.messages || []).find(m => m.id === fileMatch[2]);
    if (!msg || !msg.r2Key) return json({ error: 'Not found', errorCode: 'NOT_FOUND' }, 404);
    const obj = await env.FILES.get(msg.r2Key);
    if (!obj) return json({ error: 'File not found', errorCode: 'FILE_NOT_FOUND' }, 404);
    const headers: Record<string, string> = { 'Content-Type': msg.fileMime || 'application/octet-stream' };
    const safeName = (msg.fileName || 'file').replace(/[\x00-\x1f"\\]/g, '_').replace(/[^\x20-\x7e]/g, '_');
    if (msg.type === 'image') {
      headers['Content-Disposition'] = `inline; filename="${safeName}"`;
    } else {
      headers['Content-Disposition'] = `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`;
    }
    return new Response(obj.body, { headers });
  }

  // Delete room (cleanup R2 + KV + index)
  const delRoomMatch = path.match(/^\/api\/room\/([a-z0-9]+)$/);
  if (delRoomMatch && method === 'DELETE') {
    const room = await getRoom(kv, delRoomMatch[1]);
    if (!room) return json({ error: 'Room not found or expired', errorCode: 'ROOM_NOT_FOUND' }, 404);
    const pin = request.headers.get('X-Room-Pin');
    if (pin !== room.pin) return json({ error: 'Wrong PIN', errorCode: 'WRONG_PIN' }, 403);
    await cleanupRoomFiles(env.FILES, delRoomMatch[1]);
    await deleteRoom(kv, delRoomMatch[1]);
    await removeRoomFromIndex(kv, delRoomMatch[1]);
    return json({ ok: true });
  }

  // ============ Static Pages ============
  if (path === '/about') {
    const lang = parseAcceptLanguage(request);
    return new Response(getPageHTML('about', lang), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (path === '/privacy') {
    const lang = parseAcceptLanguage(request);
    return new Response(getPageHTML('privacy', lang), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }

  // ============ Serve Frontend ============
  if (path === '/' || path.match(/^\/room\/[a-z0-9]+$/)) {
    return new Response(getHTML(parseAcceptLanguage(request)), {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  return json({ error: 'Not found', errorCode: 'NOT_FOUND' }, 404);
}

// ============ Create Room ============
async function handleCreateRoom(request: Request, ip: string, kv: KVNamespace, turnstileSecret: string, turnstileSiteKey: string): Promise<Response> {
  let body: { ttl?: number; turnstile?: string };
  try { body = await request.json() as { ttl?: number; turnstile?: string }; } catch { body = {}; }

  const now = Date.now();

  // Check creation blacklist
  const cbl = await getCreateBlacklist(kv, ip);
  if (cbl) {
    const remaining = Math.ceil((cbl.until - now) / 1000 / 60);
    return json({ error: `Too many creations, retry in ${remaining} minutes`, errorCode: 'CREATE_BLACKLISTED', remaining, blacklisted: true, retryAfter: cbl.until - now }, 429);
  }

  // Track creation
  let tracker = await getCreateTracker(kv, ip);
  tracker.timestamps = (tracker.timestamps || []).filter(t => now - t < 600_000);
  const recentCount = tracker.timestamps.length;

  if (recentCount >= 10) {
    await setCreateBlacklist(kv, ip, now + 3600_000);
    return json({ error: 'Too many creations, blocked for 60 minutes', errorCode: 'CREATE_RATE_LIMIT', blacklisted: true, retryAfter: 3600_000 }, 429);
  }

  if (recentCount >= 3) {
    if (turnstileSiteKey) {
      if (!body.turnstile) {
        return json({ error: 'Too many creations, verification required', errorCode: 'CREATE_NEED_VERIFY', requireTurnstile: true }, 403);
      }
      const ok = await verifyTurnstile(turnstileSecret, body.turnstile, ip);
      if (!ok) {
        return json({ error: 'Verification failed, please retry', errorCode: 'VERIFY_FAILED', requireTurnstile: true }, 403);
      }
    } else {
      const cooldownEnd = tracker.timestamps[0] + 120_000;
      if (now < cooldownEnd) {
        const wait = Math.ceil((cooldownEnd - now) / 1000);
        return json({ error: `Too many creations, please wait ${wait} seconds`, errorCode: 'CREATE_COOLDOWN', wait, retryAfter: cooldownEnd - now }, 429);
      }
    }
  }

  tracker.timestamps.push(now);
  await setCreateTracker(kv, ip, tracker);

  const id = genRoomId();
  const pin = genPin();
  const ttl = TTL_OPTIONS.includes(body.ttl || 0) ? body.ttl! : 1;
  const room: Room = {
    id, pin, ttlHours: ttl,
    createdAt: now, lastActivityAt: now,
    ipNames: {}, messages: [],
  };
  await saveRoom(kv, room);
  await addRoomToIndex(kv, room);
  return json({ roomId: id, pin, ttlHours: ttl });
}

// ============ Join Room ============
async function handleJoinRoom(request: Request, roomId: string, ip: string, kv: KVNamespace, turnstileSecret: string, turnstileSiteKey: string): Promise<Response> {
  const room = await getRoom(kv, roomId);
  if (!room) return json({ error: 'Room not found or expired', errorCode: 'ROOM_NOT_FOUND' }, 404);

  let body: { pin?: string; turnstile?: string };
  try { body = await request.json() as { pin?: string; turnstile?: string }; } catch { body = {}; }

  const now = Date.now();

  // Check blacklist
  const bl = await getBlacklist(kv, ip);
  if (bl) {
    const remaining = Math.ceil((bl.until - now) / 1000 / 60);
    return json({ error: `Too many attempts, blocked. Retry in ${remaining} minutes`, errorCode: 'JOIN_BLACKLISTED', remaining, blacklisted: true, retryAfter: bl.until - now }, 429);
  }

  const fails = await getFailCount(kv, ip, roomId);

  // Cooldown after 3 fails
  if (fails.count >= 3 && fails.count < 6) {
    const delays = [0, 0, 0, 5, 10, 30];
    const delay = (delays[fails.count] || 30) * 1000;
    const elapsed = now - (fails.lastFail || 0);
    if (elapsed < delay) {
      const wait = Math.ceil((delay - elapsed) / 1000);
      return json({ error: `Please wait ${wait} seconds`, errorCode: 'JOIN_COOLDOWN', wait, retryAfter: delay - elapsed, fails: fails.count }, 429);
    }
  }

  // Turnstile after 3 fails
  if (turnstileSiteKey && fails.count >= 3) {
    if (!body.turnstile) {
      return json({ error: 'Too many wrong PINs, verification required', errorCode: 'JOIN_NEED_VERIFY', requireTurnstile: true, fails: fails.count }, 403);
    }
    const ok = await verifyTurnstile(turnstileSecret, body.turnstile, ip);
    if (!ok) {
      return json({ error: 'Verification failed, please retry', errorCode: 'VERIFY_FAILED', requireTurnstile: true, fails: fails.count }, 403);
    }
  }

  // Check PIN
  if (body.pin === room.pin) {
    await deleteFailCount(kv, ip, roomId);
    const name = assignName(room, ip);
    await saveRoom(kv, room);
    return json({ ok: true, name });
  }

  // Wrong PIN
  fails.count++;
  fails.lastFail = now;
  await setFailCount(kv, ip, roomId, fails);

  if (fails.count >= 6) {
    await setBlacklist(kv, ip, now + 30 * 60_000);
    return json({ error: 'Too many attempts, blocked for 30 minutes', errorCode: 'JOIN_RATE_LIMIT', blacklisted: true, retryAfter: 30 * 60_000 }, 429);
  }

  const remaining = Math.max(0, 6 - fails.count);
  const msg = turnstileSiteKey && fails.count >= 3
    ? `Wrong PIN, verification needed (${remaining} attempts left)`
    : `Wrong PIN, ${remaining} attempts left`;

  return json({ error: msg, errorCode: 'WRONG_PIN', remaining, fails: fails.count, requireTurnstile: !!turnstileSiteKey && fails.count >= 3 }, 403);
}

// ============ Send Message ============
async function handleSendMessage(request: Request, roomId: string, ip: string, kv: KVNamespace, bucket: R2Bucket): Promise<Response> {
  const room = await getRoom(kv, roomId);
  if (!room) return json({ error: 'Room not found or expired', errorCode: 'ROOM_NOT_FOUND' }, 404);

  const formData = await request.formData();
  const pin = formData.get('pin');
  if (pin !== room.pin) return json({ error: 'Wrong PIN', errorCode: 'WRONG_PIN' }, 403);

  const sender = ((formData.get('sender') as string) || '').trim().slice(0, 30) || assignName(room, ip);
  const text = (formData.get('text') as string)?.trim() || null;
  const file = formData.get('file') as File | null;

  if (!text && !file) return json({ error: 'Empty message', errorCode: 'EMPTY_MESSAGE' }, 400);

  if (text && text.length > 10000) return json({ error: 'Message too long', errorCode: 'MESSAGE_TOO_LONG' }, 400);
  if (file && file.size > 100 * 1024 * 1024) return json({ error: 'File too large (max 100MB)', errorCode: 'FILE_TOO_LARGE' }, 400);

  let type: 'text' | 'image' | 'file' = 'text';
  let fileName: string | null = null, r2Key: string | null = null, fileMime: string | null = null, fileSize: number | null = null;
  let fileMsgId: string | undefined;

  if (file && file.name) {
    type = file.type?.startsWith('image/') ? 'image' : 'file';
    fileName = file.name;
    fileMime = file.type || 'application/octet-stream';
    fileSize = file.size;
    const msgId = crypto.randomUUID();
    r2Key = `room/${roomId}/${msgId}/${fileName}`;
    const buffer = await file.arrayBuffer();
    await bucket.put(r2Key, buffer, {
      httpMetadata: { contentType: fileMime },
    });
    fileMsgId = msgId;
  }

  const msg: Message = {
    id: fileMsgId || crypto.randomUUID(),
    sender, type, text,
    fileName, r2Key, fileMime, fileSize,
    createdAt: Date.now(),
  };
  if (!room.messages) room.messages = [];
  room.messages.push(msg);
  room.lastActivityAt = Date.now();
  await saveRoom(kv, room);
  await updateRoomInIndex(kv, roomId, { lastActivityAt: room.lastActivityAt, messageCount: (room.messages || []).length, participants: Object.keys(room.ipNames || {}).length });
  return json({ ok: true, id: msg.id });
}

// ============ Delete Message ============
async function handleDeleteMessage(request: Request, roomId: string, msgId: string, ip: string, kv: KVNamespace, bucket: R2Bucket): Promise<Response> {
  const room = await getRoom(kv, roomId);
  if (!room) return json({ error: 'Room not found or expired', errorCode: 'ROOM_NOT_FOUND' }, 404);

  let body: { pin?: string };
  try { body = await request.json() as { pin?: string }; } catch { body = {}; }
  if (body.pin !== room.pin) return json({ error: 'Wrong PIN', errorCode: 'WRONG_PIN' }, 403);

  const idx = (room.messages || []).findIndex(m => m.id === msgId);
  if (idx === -1) return json({ error: 'Not found', errorCode: 'NOT_FOUND' }, 404);

  const msg = room.messages[idx];
  if (msg.r2Key && bucket) {
    try { await bucket.delete(msg.r2Key); } catch { /* R2 delete failed, orphaned file will be cleaned on room deletion */ }
  }
  room.messages.splice(idx, 1);
  await saveRoom(kv, room);
  await updateRoomInIndex(kv, roomId, { messageCount: (room.messages || []).length, lastActivityAt: room.lastActivityAt });
  return json({ ok: true });
}

// ============ Shared Translations ============
const TRANSLATIONS: Record<string, Record<string, string>> = {
  zh:{title:'文件分享',subtitle:'创建房间，分享链接和密码<br>无需注册，阅后即焚',ttlLabel:'消息有效期（无活动自动销毁）',ttl1:'1 小时',ttl6:'6 小时',ttl12:'12 小时',ttl24:'24 小时',btnCreate:'+ 创建新房间',divider:'或加入已有房间',labelRoomId:'房间号',labelPin:'4位密码',phRoomId:'例如: abc123',phPin:'例如: 4829',btnJoin:'加入房间',backCreate:'← 创建自己的房间',chatTitle:'文件分享',ttlInfo:'h 后过期',btnShare:'分享',btnLeave:'离开',emptyHint:'👋 发送一条消息开始聊天',emptySub:'支持文字、图片、文件 | 文件选择后自动上传 | Ctrl+V 粘贴图片',phInput:'输入消息... (Enter发送)',btnSend:'发送',shareTitle:'分享房间',shareDesc:'扫描二维码或发送链接',shareHint:'链接和密码需要一起发给对方',btnClose:'关闭',btnCopy:'复制',toastCopied:'已复制链接和密码',toastUploadFail:'上传失败',toastNetError:'网络错误',toastSendFail:'发送失败',toastCreateFail:'创建失败',toastExpired:'房间已过期',toastPinError:'Wrong PIN',joinTitle:'加入房间',joinSub:'输入密码以加入房间',joinNoPwd:'无密码无法进入',errRoomNotFound:'Room not found or expired',errBlacklisted:'尝试次数过多，请 {m} 分钟后重试',errMinutesLater:' 分钟后重试',errWait:'请等待 ',errSecRetry:' 秒后再试',errNeedVerify:'密码错误次数过多，需要完成验证',errVerifyFail:'验证失败，请重试',btnVerifyJoin:'验证后加入',errWrongPin:'密码错误，还需验证（剩余',errChances:' 次机会）',errWrongPinNormal:'密码错误，剩余',errAttempts:' 次尝试机会',btnRetry:'秒后重试',btnMinRetry:'分',btnSecRetry:'秒后',btnVerifyCreate:'验证后创建',errCreateFrequent:'创建过于频繁，',errCreateBlacklist:'创建过于频繁，已被限制 60 分钟',errCreateCooldown:'创建过于频繁，请等待 {s} 秒',errBlacklist30:'尝试次数过多，已被拉黑 30 分钟',errFileNotExist:'文件不存在',qrFail:'二维码加载失败',qrFailSub:'请使用下方链接',phNeedRoomId:'请输入房间号和4位密码',orJoin:'已加入的房间',activeRooms:'个活跃房间',roomMsgs:'消息',roomExpires:'到期',btnRoomJoin:'进入',noRooms:'暂无已加入的房间',errCooldown:'请等待 {s} 秒',errCreateBlacklisted:'创建过于频繁，请 {m} 分钟后重试',errWrongAttempts:'密码错误，剩余 {n} 次机会',errEmptyMsg:'消息不能为空',errFileNotFound:'文件不存在',aboutTitle:'关于我们',aboutContent:'<p>文件分享是一个临时文件分享工具。</p><p>创建房间后，分享链接和密码即可与他人传输文件、图片和文字消息。所有数据在房间到期或无活动后自动销毁，无需注册，阅后即焚。</p><p>支持 1小时 / 6小时 / 12小时 / 24小时 有效期，最大支持 100MB 文件上传。</p>',privacyTitle:'隐私政策',privacyContent:'<p><strong>无需注册</strong> — 使用本服务不需要任何账号或个人信息。</p><p><strong>临时存储</strong> — 所有消息和文件存储在加密的临时房间中，房间到期或无活动后自动永久删除。</p><p><strong>文件清理</strong> — 上传的文件存储在 Cloudflare R2 中，随房间一起自动销毁。</p><p><strong>IP 记录</strong> — 仅用于速率限制和自动分配用户名，不用于追踪或分析。</p><p><strong>开源</strong> — 本项目完全开源，代码可在 <a href="https://github.com/ruodeng/chat" target="_blank" style="color:#7b8cff">GitHub</a> 查看。</p>',footerAbout:'关于',footerPrivacy:'隐私',backHome:'← 返回首页',errMessageTooLong:'消息长度不能超过 10000 字符',errFileTooLarge:'文件大小不能超过 100MB',confirmLeave:'确定要离开房间吗？'},
  en:{title:'File Share',subtitle:'Create a room, share link &amp; PIN<br>No registration, auto-destroy',ttlLabel:'Message lifetime (auto-destroy after inactivity)',ttl1:'1 hour',ttl6:'6 hours',ttl12:'12 hours',ttl24:'24 hours',btnCreate:'+ Create Room',divider:'or join existing room',labelRoomId:'Room ID',labelPin:'4-digit PIN',phRoomId:'e.g. abc123',phPin:'e.g. 4829',btnJoin:'Join Room',backCreate:'← Create your own room',chatTitle:'File Share',ttlInfo:'h until expiry',btnShare:'Share',btnLeave:'Leave',emptyHint:'👋 Send a message to start chatting',emptySub:'Text, images, files | Files auto-upload on selection | Ctrl+V to paste image',phInput:'Type a message... (Enter to send)',btnSend:'Send',shareTitle:'Share Room',shareDesc:'Scan QR code or send link',shareHint:'Send both the link and PIN to your contact',btnClose:'Close',btnCopy:'Copy',toastCopied:'Link and PIN copied',toastUploadFail:'Upload failed',toastNetError:'Network error',toastSendFail:'Send failed',toastCreateFail:'Creation failed',toastExpired:'Room has expired',toastPinError:'Wrong PIN',joinTitle:'Join Room',joinSub:'Enter PIN to join the room',joinNoPwd:'PIN is required',errRoomNotFound:'Room not found or expired',errBlacklisted:'Too many attempts, blocked. Retry in {m} minutes',errMinutesLater:' minutes',errWait:'Please wait ',errSecRetry:' seconds',errNeedVerify:'Too many wrong PINs, verification required',errVerifyFail:'Verification failed, please retry',btnVerifyJoin:'Verify &amp; Join',errWrongPin:'Wrong PIN, verification needed (',errChances:' attempts left)',errWrongPinNormal:'Wrong PIN, ',errAttempts:' attempts left',btnRetry:'s retry',btnMinRetry:'m ',btnSecRetry:'s',btnVerifyCreate:'Verify &amp; Create',errCreateFrequent:'Too many creations, ',errCreateBlacklist:'Too many creations, blocked for 60 minutes',errCreateCooldown:'Too many creations, please wait {s} seconds',errBlacklist30:'Too many attempts, blocked for 30 minutes',errFileNotExist:'File not found',qrFail:'QR code failed to load',qrFailSub:'Please use the link below',phNeedRoomId:'Please enter room ID and 4-digit PIN',orJoin:'Your rooms',activeRooms:'active room(s)',roomMsgs:'messages',roomExpires:'expires',btnRoomJoin:'Enter',noRooms:'No saved rooms yet',errCooldown:'Please wait {s} seconds',errCreateBlacklisted:'Too many creations, retry in {m} minutes',errWrongAttempts:'Wrong PIN, {n} attempts left',errEmptyMsg:'Empty message',errFileNotFound:'File not found',aboutTitle:'About Us',aboutContent:'<p>File Share is a temporary file sharing service.</p><p>Create a room, share the link and PIN, and exchange files, images, and text messages. All data auto-destroys when the room expires or after inactivity. No registration required.</p><p>Supports 1h / 6h / 12h / 24h expiry, with up to 100MB file uploads.</p>',privacyTitle:'Privacy Policy',privacyContent:'<p><strong>No Registration</strong> — No account or personal information is required to use this service.</p><p><strong>Temporary Storage</strong> — All messages and files are stored in encrypted temporary rooms and permanently deleted when the room expires or after inactivity.</p><p><strong>File Cleanup</strong> — Uploaded files are stored in Cloudflare R2 and automatically destroyed with the room.</p><p><strong>IP Address</strong> — Used only for rate limiting and auto-assigning usernames. Not used for tracking or analytics.</p><p><strong>Open Source</strong> — This project is fully open source. View the code on <a href="https://github.com/ruodeng/chat" target="_blank" style="color:#7b8cff">GitHub</a>.</p>',footerAbout:'About',footerPrivacy:'Privacy',backHome:'← Back to Home',errMessageTooLong:'Message too long (max 10,000 characters)',errFileTooLarge:'File too large (max 100MB)',confirmLeave:'Leave room?'},
  de:{title:'Dateifreigabe',subtitle:'Raum erstellen, Link &amp; PIN teilen<br>Keine Registrierung, auto-zerstörend',ttlLabel:'Nachrichtengültigkeit (auto-zerstörung nach Inaktivität)',ttl1:'1 Stunde',ttl6:'6 Stunden',ttl12:'12 Stunden',ttl24:'24 Stunden',btnCreate:'+ Raum erstellen',divider:'oder bestehendem Raum beitreten',labelRoomId:'Raum-ID',labelPin:'4-stelliger PIN',phRoomId:'z.B. abc123',phPin:'z.B. 4829',btnJoin:'Beitreten',backCreate:'← Eigenen Raum erstellen',chatTitle:'Dateifreigabe',ttlInfo:'h bis Ablauf',btnShare:'Teilen',btnLeave:'Verlassen',emptyHint:'👋 Nachricht senden um zu starten',emptySub:'Text, Bilder, Dateien | Dateien werden automatisch hochgeladen | Strg+V zum Einfügen',phInput:'Nachricht eingeben... (Enter zum Senden)',btnSend:'Senden',shareTitle:'Raum teilen',shareDesc:'QR-Code scannen oder Link senden',shareHint:'Link und PIN an Ihren Kontakt senden',btnClose:'Schließen',btnCopy:'Kopieren',toastCopied:'Link und PIN kopiert',toastUploadFail:'Upload fehlgeschlagen',toastNetError:'Netzwerkfehler',toastSendFail:'Senden fehlgeschlagen',toastCreateFail:'Erstellung fehlgeschlagen',toastExpired:'Raum ist abgelaufen',toastPinError:'Falscher PIN',joinTitle:'Raum beitreten',joinSub:'PIN eingeben um beizutreten',joinNoPwd:'PIN ist erforderlich',errRoomNotFound:'Raum nicht gefunden oder abgelaufen',errBlacklisted:'Zu viele Versuche, gesperrt. Erneut versuchen in {m} Minuten',errMinutesLater:' Minuten',errWait:'Bitte warten ',errSecRetry:' Sekunden',errNeedVerify:'Zu viele falsche PINs, Verifizierung erforderlich',errVerifyFail:'Verifizierung fehlgeschlagen',btnVerifyJoin:'Verifizieren &amp; Beitreten',errWrongPin:'Falscher PIN, Verifizierung nötig (',errChances:' Versuche übrig)',errWrongPinNormal:'Falscher PIN, ',errAttempts:' Versuche übrig',btnRetry:'s warten',btnMinRetry:'m ',btnSecRetry:'s',btnVerifyCreate:'Verifizieren &amp; Erstellen',errCreateFrequent:'Zu viele Erstellungen, ',errCreateBlacklist:'Zu viele Erstellungen, 60 Min. gesperrt',errCreateCooldown:'Zu viele Erstellungen, bitte warten {s} Sekunden',errBlacklist30:'Zu viele Versuche, 30 Min. gesperrt',errFileNotExist:'Datei nicht gefunden',qrFail:'QR-Code konnte nicht geladen werden',qrFailSub:'Bitte nutzen Sie den Link unten',phNeedRoomId:'Bitte Raum-ID und 4-stelligen PIN eingeben',orJoin:'Ihre Räume',activeRooms:'aktive(s) Raum/Räume',roomMsgs:'Nachrichten',roomExpires:'läuft ab',btnRoomJoin:'Betreten',noRooms:'Noch keine Räume beigetreten',errCooldown:'Bitte warten {s} Sekunden',errCreateBlacklisted:'Zu viele Erstellungen, erneut versuchen in {m} Minuten',errWrongAttempts:'Falscher PIN, {n} Versuche übrig',errEmptyMsg:'Leere Nachricht',errFileNotFound:'Datei nicht gefunden',aboutTitle:'Über uns',aboutContent:'<p>Dateifreigabe ist ein temporärer Dateifreigabe-Dienst.</p><p>Erstellen Sie einen Raum, teilen Sie Link und PIN, und tauschen Sie Dateien, Bilder und Textnachrichten aus. Alle Daten werden automatisch zerstört, wenn der Raum abläuft oder nach Inaktivität. Keine Registrierung erforderlich.</p><p>Unterstützt 1h / 6h / 12h / 24h Ablaufzeit mit bis zu 100MB Datei-Uploads.</p>',privacyTitle:'Datenschutzrichtlinie',privacyContent:'<p><strong>Keine Registrierung</strong> — Es ist kein Konto oder persönliche Daten erforderlich.</p><p><strong>Temporäre Speicherung</strong> — Alle Nachrichten und Dateien werden in verschlüsselten temporären Räumen gespeichert und beim Ablauf oder nach Inaktivität dauerhaft gelöscht.</p><p><strong>Dateibereinigung</strong> — Hochgeladene Dateien werden in Cloudflare R2 gespeichert und mit dem Raum automatisch zerstört.</p><p><strong>IP-Adresse</strong> — Wird nur für Rate-Limiting und automatische Benutzernamen verwendet. Nicht für Tracking oder Analyse.</p><p><strong>Open Source</strong> — Dieses Projekt ist vollständig Open Source. Code ansehen auf <a href="https://github.com/ruodeng/chat" target="_blank" style="color:#7b8cff">GitHub</a>.</p>',footerAbout:'Über uns',footerPrivacy:'Datenschutz',backHome:'← Zurück zur Startseite',errMessageTooLong:'Nachricht zu lang (max 10.000 Zeichen)',errFileTooLarge:'Datei zu groß (max 100MB)',confirmLeave:'Raum verlassen?'},
  fr:{title:'Partage de fichiers',subtitle:'Créer un salon, partager le lien et le PIN<br>Sans inscription, auto-destruction',ttlLabel:'Durée des messages (destruction après inactivité)',ttl1:'1 heure',ttl6:'6 heures',ttl12:'12 heures',ttl24:'24 heures',btnCreate:'+ Créer un salon',divider:'ou rejoindre un salon existant',labelRoomId:'ID du salon',labelPin:'PIN à 4 chiffres',phRoomId:'ex: abc123',phPin:'ex: 4829',btnJoin:'Rejoindre',backCreate:'← Créer votre propre salon',chatTitle:'Partage de fichiers',ttlInfo:'h avant expiration',btnShare:'Partager',btnLeave:'Quitter',emptyHint:'👋 Envoyez un message pour commencer',emptySub:'Texte, images, fichiers | Upload auto des fichiers | Ctrl+V pour coller une image',phInput:'Écrire un message... (Entrée pour envoyer)',btnSend:'Envoyer',shareTitle:'Partager le salon',shareDesc:'Scanner le QR ou envoyer le lien',shareHint:'Envoyez le lien et le PIN à votre contact',btnClose:'Fermer',btnCopy:'Copier',toastCopied:'Lien et PIN copiés',toastUploadFail:"Échec de l'upload",toastNetError:'Erreur réseau',toastSendFail:"Échec de l'envoi",toastCreateFail:'Échec de la création',toastExpired:'Le salon a expiré',toastPinError:'PIN incorrect',joinTitle:'Rejoindre le salon',joinSub:'Entrez le PIN pour rejoindre',joinNoPwd:'Le PIN est requis',errRoomNotFound:'Salon introuvable ou expiré',errBlacklisted:'Trop de tentatives, bloqué. Réessayer dans {m} minutes',errMinutesLater:' minutes',errWait:'Veuillez patienter ',errSecRetry:' secondes',errNeedVerify:'Trop de PIN incorrects, vérification requise',errVerifyFail:'Échec de la vérification',btnVerifyJoin:'Vérifier &amp; Rejoindre',errWrongPin:'PIN incorrect, vérification nécessaire (',errChances:' essais restants)',errWrongPinNormal:'PIN incorrect, ',errAttempts:' essais restants',btnRetry:'s',btnMinRetry:'m ',btnSecRetry:'s',btnVerifyCreate:'Vérifier &amp; Créer',errCreateFrequent:'Trop de créations, ',errCreateBlacklist:'Trop de créations, bloqué 60 minutes',errCreateCooldown:'Trop de créations, veuillez patienter {s} secondes',errBlacklist30:'Trop de tentatives, bloqué 30 minutes',errFileNotExist:'Fichier introuvable',qrFail:'Échec du chargement du QR',qrFailSub:'Utilisez le lien ci-dessous',phNeedRoomId:'Entrez ID du salon et PIN à 4 chiffres',orJoin:'Vos salons',activeRooms:'salon(s) actif(s)',roomMsgs:'messages',roomExpires:'expire',btnRoomJoin:'Entrer',noRooms:'Aucun salon rejoint',errCooldown:'Veuillez patienter {s} secondes',errCreateBlacklisted:'Trop de créations, réessayer dans {m} minutes',errWrongAttempts:'PIN incorrect, {n} essais restants',errEmptyMsg:'Message vide',errFileNotFound:'Fichier introuvable',aboutTitle:'À propos',aboutContent:'<p>Partage de fichiers est un service de partage de fichiers temporaire.</p><p>Créez un salon, partagez le lien et le PIN, et échangez des fichiers, images et messages texte. Toutes les données sont automatiquement détruites lors de l\'expiration du salon ou après inactivité. Aucune inscription requise.</p><p>Supporte 1h / 6h / 12h / 24h d\'expiration, avec des téléchargements jusqu\'à 100 Mo.</p>',privacyTitle:'Politique de confidentialité',privacyContent:'<p><strong>Aucune inscription</strong> — Aucun compte ou information personnelle n\'est requis.</p><p><strong>Stockage temporaire</strong> — Tous les messages et fichiers sont stockés dans des salons temporaires cryptés et supprimés définitivement lors de l\'expiration ou après inactivité.</p><p><strong>Nettoyage des fichiers</strong> — Les fichiers téléchargés sont stockés dans Cloudflare R2 et automatiquement détruits avec le salon.</p><p><strong>Adresse IP</strong> — Utilisée uniquement pour la limitation de débit et l\'attribution automatique de noms d\'utilisateur. Pas utilisée pour le suivi ou l\'analyse.</p><p><strong>Open Source</strong> — Ce projet est entièrement open source. Voir le code sur <a href="https://github.com/ruodeng/chat" target="_blank" style="color:#7b8cff">GitHub</a>.</p>',footerAbout:'À propos',footerPrivacy:'Confidentialité',backHome:'← Retour à l\'accueil',errMessageTooLong:'Message trop long (max 10 000 caractères)',errFileTooLarge:'Fichier trop volumineux (max 100 Mo)',confirmLeave:'Quitter le salon ?'},
  ja:{title:'ファイル共有',subtitle:'ルームを作成、リンクとPINを共有<br>登録不要、自動消去',ttlLabel:'メッセージ有効期限（非活動で自動消去）',ttl1:'1時間',ttl6:'6時間',ttl12:'12時間',ttl24:'24時間',btnCreate:'+ ルーム作成',divider:'または既存のルームに参加',labelRoomId:'ルームID',labelPin:'4桁PIN',phRoomId:'例: abc123',phPin:'例: 4829',btnJoin:'参加',backCreate:'← 自分のルームを作成',chatTitle:'ファイル共有',ttlInfo:'時間で期限切れ',btnShare:'共有',btnLeave:'退出',emptyHint:'👋 メッセージを送信してチャット開始',emptySub:'テキスト、画像、ファイル | ファイルは選択時に自動アップロード | Ctrl+Vで画像貼り付け',phInput:'メッセージ入力... (Enterで送信)',btnSend:'送信',shareTitle:'ルーム共有',shareDesc:'QRコードをスキャンまたはリンクを送信',shareHint:'リンクとPINを相手に送ってください',btnClose:'閉じる',btnCopy:'コピー',toastCopied:'リンクとPINをコピーしました',toastUploadFail:'アップロード失敗',toastNetError:'ネットワークエラー',toastSendFail:'送信失敗',toastCreateFail:'作成失敗',toastExpired:'ルームの期限が切れました',toastPinError:'PINが間違っています',joinTitle:'ルームに参加',joinSub:'PINを入力して参加',joinNoPwd:'PINが必要です',errRoomNotFound:'ルームが見つからないか期限切れです',errBlacklisted:'試行回数多すぎ、ブロック。{m}分後に再試行',errMinutesLater:'分',errWait:'お待ちください ',errSecRetry:'秒',errNeedVerify:'PIN間違い多すぎ、認証が必要です',errVerifyFail:'認証失敗、再試行してください',btnVerifyJoin:'認証して参加',errWrongPin:'PIN間違い、認証必要（残り',errChances:'回）',errWrongPinNormal:'PIN間違い、残り',errAttempts:'回',btnRetry:'秒後',btnMinRetry:'分',btnSecRetry:'秒',btnVerifyCreate:'認証して作成',errCreateFrequent:'作成多すぎ、',errCreateBlacklist:'作成多すぎ、60分ブロック',errCreateCooldown:'作成多すぎ、{s}秒お待ちください',errBlacklist30:'試行多すぎ、30分ブロック',errFileNotExist:'ファイルが見つかりません',qrFail:'QRコードの読み込み失敗',qrFailSub:'下のリンクをご利用ください',phNeedRoomId:'ルームIDと4桁PINを入力してください',orJoin:'参加済みルーム',activeRooms:'個のアクティブルーム',roomMsgs:'メッセージ',roomExpires:'期限',btnRoomJoin:'入室',noRooms:'参加済みルームなし',errCooldown:'{s}秒お待ちください',errCreateBlacklisted:'作成多すぎ、{m}分後に再試行',errWrongAttempts:'PIN間違い、残り{n}回',errEmptyMsg:'メッセージが空です',errFileNotFound:'ファイルが見つかりません',aboutTitle:'について',aboutContent:'<p>ファイル共有は、一時的なファイル共有サービスです。</p><p>ルームを作成し、リンクとPINを共有すると、ファイル、画像、テキストメッセージを送受信できます。ルームの期限切れや非活動後にすべてのデータは自動的に削除されます。登録不要。</p><p>1時間 / 6時間 / 12時間 / 24時間の有効期限に対応。最大100MBのファイルアップロード。</p>',privacyTitle:'プライバシーポリシー',privacyContent:'<p><strong>登録不要</strong> — アカウントや個人情報は不要です。</p><p><strong>一時保存</strong> — すべてのメッセージとファイルは暗号化された一時ルームに保存され、期限切れや非活動後に永久に削除されます。</p><p><strong>ファイル削除</strong> — アップロードされたファイルはCloudflare R2に保存され、ルームと一緒に自動的に削除されます。</p><p><strong>IPアドレス</strong> — レート制限とユーザー名の自動割り当てにのみ使用。追跡や分析には使用されません。</p><p><strong>オープンソース</strong> — このプロジェクトは完全にオープンソースです。コードは<a href="https://github.com/ruodeng/chat" target="_blank" style="color:#7b8cff">GitHub</a>でご覧いただけます。</p>',footerAbout:'について',footerPrivacy:'プライバシー',backHome:'← ホームに戻る',errMessageTooLong:'メッセージが長すぎます（最大10,000文字）',errFileTooLarge:'ファイルが大きすぎます（最大100MB）',confirmLeave:'ルームを離れますか？'},
  es:{title:'Compartir archivos',subtitle:'Crea una sala, comparte enlace y PIN<br>Sin registro, auto-destrucción',ttlLabel:'Duración de mensajes (auto-destrucción por inactividad)',ttl1:'1 hora',ttl6:'6 horas',ttl12:'12 horas',ttl24:'24 horas',btnCreate:'+ Crear Sala',divider:'o unirse a una sala existente',labelRoomId:'ID de Sala',labelPin:'PIN de 4 dígitos',phRoomId:'ej: abc123',phPin:'ej: 4829',btnJoin:'Unirse',backCreate:'← Crear tu propia sala',chatTitle:'Compartir archivos',ttlInfo:'h para expirar',btnShare:'Compartir',btnLeave:'Salir',emptyHint:'👋 Envía un mensaje para empezar',emptySub:'Texto, imágenes, archivos | Archivos se suben automáticamente | Ctrl+V para pegar imagen',phInput:'Escribe un mensaje... (Enter para enviar)',btnSend:'Enviar',shareTitle:'Compartir Sala',shareDesc:'Escanea QR o envía el enlace',shareHint:'Envía el enlace y PIN a tu contacto',btnClose:'Cerrar',btnCopy:'Copiar',toastCopied:'Enlace y PIN copiados',toastUploadFail:'Error de subida',toastNetError:'Error de red',toastSendFail:'Error al enviar',toastCreateFail:'Error al crear',toastExpired:'La sala ha expirado',toastPinError:'PIN incorrecto',joinTitle:'Unirse a la sala',joinSub:'Ingresa el PIN para unirte',joinNoPwd:'El PIN es obligatorio',errRoomNotFound:'Sala no encontrada o expirada',errBlacklisted:'Demasiados intentos, bloqueado. Reintentar en {m} minutos',errMinutesLater:' minutos',errWait:'Por favor espera ',errSecRetry:' segundos',errNeedVerify:'Demasiados PIN incorrectos, verificación requerida',errVerifyFail:'Verificación fallida',btnVerifyJoin:'Verificar y Unirse',errWrongPin:'PIN incorrecto, verificación necesaria (',errChances:' intentos restantes)',errWrongPinNormal:'PIN incorrecto, ',errAttempts:' intentos restantes',btnRetry:'s',btnMinRetry:'m ',btnSecRetry:'s',btnVerifyCreate:'Verificar y Crear',errCreateFrequent:'Demasiadas creaciones, ',errCreateBlacklist:'Demasiadas creaciones, bloqueado 60 minutos',errCreateCooldown:'Demasiadas creaciones, espera {s} segundos',errBlacklist30:'Demasiados intentos, bloqueado 30 minutos',errFileNotExist:'Archivo no encontrado',qrFail:'Error al cargar QR',qrFailSub:'Usa el enlace de abajo',phNeedRoomId:'Ingresa ID de sala y PIN de 4 dígitos',orJoin:'Tus salas',activeRooms:'sala(s) activa(s)',roomMsgs:'mensajes',roomExpires:'expira',btnRoomJoin:'Entrar',noRooms:'Aún no hay salas guardadas',errCooldown:'Por favor espera {s} segundos',errCreateBlacklisted:'Demasiadas creaciones, reintentar en {m} minutos',errWrongAttempts:'PIN incorrecto, {n} intentos restantes',errEmptyMsg:'Mensaje vacío',errFileNotFound:'Archivo no encontrado',aboutTitle:'Sobre nosotros',aboutContent:'<p>Compartir archivos es un servicio temporal de intercambio de archivos.</p><p>Crea una sala, comparte el enlace y el PIN, e intercambia archivos, imágenes y mensajes de texto. Todos los datos se destruyen automáticamente cuando la sala expira o después de inactividad. Sin registro requerido.</p><p>Soporta 1h / 6h / 12h / 24h de expiración, con subidas de hasta 100MB.</p>',privacyTitle:'Política de privacidad',privacyContent:'<p><strong>Sin registro</strong> — No se requiere cuenta ni información personal.</p><p><strong>Almacenamiento temporal</strong> — Todos los mensajes y archivos se almacenan en salas temporales encriptadas y se eliminan permanentemente cuando la sala expira o después de inactividad.</p><p><strong>Limpieza de archivos</strong> — Los archivos subidos se almacenan en Cloudflare R2 y se destruyen automáticamente con la sala.</p><p><strong>Dirección IP</strong> — Se utiliza solo para limitación de velocidad y asignación automática de nombres de usuario. No se usa para rastreo o análisis.</p><p><strong>Código abierto</strong> — Este proyecto es totalmente de código abierto. Ver el código en <a href="https://github.com/ruodeng/chat" target="_blank" style="color:#7b8cff">GitHub</a>.</p>',footerAbout:'Acerca de',footerPrivacy:'Privacidad',backHome:'← Volver al inicio',errMessageTooLong:'Mensaje demasiado largo (máx. 10.000 caracteres)',errFileTooLarge:'Archivo demasiado grande (máx. 100MB)',confirmLeave:'¿Salir de la sala?'}
};

// ============ Static Pages ============
function getPageHTML(page: 'about' | 'privacy', lang: string = 'en'): string {
  const t = (k: string) => (TRANSLATIONS[lang] || TRANSLATIONS.en)[k] || TRANSLATIONS.en[k] || k;
  const title = page === 'about' ? t('aboutTitle') : t('privacyTitle');
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - File Share</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#111;color:#e0e0e0;min-height:100vh;display:flex;justify-content:center}
.page{width:100%;max-width:700px;padding:24px;display:flex;flex-direction:column;gap:20px}
.back{color:#7b8cff;text-decoration:none;font-size:14px;display:inline-block;margin-bottom:8px}
.back:hover{text-decoration:underline}
h1{font-size:24px;font-weight:700}
.content{line-height:1.8;font-size:15px;color:#ccc}
.content p{margin-bottom:14px}
.content strong{color:#e0e0e0}
.content a{color:#7b8cff;text-decoration:none}
.content a:hover{text-decoration:underline}
.footer{border-top:1px solid #2a2a2a;padding-top:16px;display:flex;gap:16px;font-size:13px;color:#555}
.footer a{color:#555;text-decoration:none}
.footer a:hover{color:#aaa}
</style>
</head>
<body>
<button class="theme-toggle" id="btn-theme" aria-label="Toggle theme">&#x2600;</button>
<div class="page">
<a href="/" class="back" id="back-link"></a>
<h1 id="page-title"></h1>
<div class="content" id="page-content"></div>
<div class="footer" id="page-footer"></div>
</div>
<script>
const T=${JSON.stringify(TRANSLATIONS)};
const lang=(navigator.language||navigator.browserLanguage||'en').toLowerCase();
const tl=k=>(T[lang]||T[lang.split('-')[0]]||T.en)[k]||T.en[k]||k;
document.getElementById('back-link').textContent=tl('backHome');
document.getElementById('page-title').textContent=tl('${page}Title');
document.getElementById('page-content').innerHTML=tl('${page}Content');
document.getElementById('page-footer').innerHTML='<a href="/about">'+tl('footerAbout')+'</a><a href="/privacy">'+tl('footerPrivacy')+'</a>';
</script>
</body>
</html>`;
}

// ============ HTML Template ============
function getHTML(lang: string = 'en'): string {
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>File Share</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;overflow:hidden}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#111;color:#e0e0e0;display:flex;justify-content:center}
.app{width:100%;max-width:700px;height:100%;display:flex;flex-direction:column}
.landing{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;gap:24px}
.landing h1{font-size:28px;font-weight:700}
.landing .sub{color:#777;font-size:14px;text-align:center;line-height:1.6}
body.is-joining #create-card{display:none!important}
body.is-joining #join-divider{display:none!important}
body.is-joining .back-link{display:inline!important}
.landing .card{width:100%;max-width:360px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:12px;padding:24px;display:flex;flex-direction:column;gap:16px}
.card label{font-size:13px;color:#888}
.card input{width:100%;background:#222;border:1px solid #333;color:#e0e0e0;border-radius:8px;padding:10px 12px;font-size:15px;outline:none;font-family:monospace;letter-spacing:2px}
.card input:focus,.card select:focus{border-color:#5b7cff}
.card select{width:100%;background:#222;border:1px solid #333;color:#e0e0e0;border-radius:8px;padding:10px 12px;font-size:14px;outline:none;cursor:pointer;appearance:none}
.btn{padding:10px 20px;font-size:14px;border-radius:8px;cursor:pointer;border:none;font-weight:500;transition:background .15s}
.btn-primary{background:#3a5ae0;color:#fff;width:100%}
.btn-primary:hover{background:#4b6bf0}
.btn-secondary{background:#2a2a2a;color:#e0e0e0;border:1px solid #3a3a3a}
.btn-secondary:hover{background:#333}
.btn-danger{background:#5a2020;color:#e88;border:1px solid #5a3030}
.btn-danger:hover{background:#6a2828}
.divider{display:flex;align-items:center;gap:12px;color:#555;font-size:12px}
.divider::before,.divider::after{content:'';flex:1;border-top:1px solid #2a2a2a}
.back-link{display:none;text-align:center;font-size:13px;color:#777;text-decoration:none;transition:color .15s}
.back-link:hover{color:#aaa}
.chat{display:none;flex:1;flex-direction:column;height:100%}
.chat.active{display:flex}
.header{padding:10px 16px;background:#1a1a1a;border-bottom:1px solid #2a2a2a;display:flex;align-items:center;gap:10px;flex-shrink:0}
.header .title{font-size:16px;font-weight:600;white-space:nowrap;cursor:pointer;transition:opacity .15s}
.header .title:hover{opacity:.7}
.header .room-tag{font-size:11px;color:#3a5ae0;background:#1a1a30;padding:3px 8px;border-radius:4px;font-family:monospace}
.header .ttl-info{font-size:10px;color:#666;white-space:nowrap}
.header .spacer{flex:1}
.header button{font-size:12px;padding:5px 10px}
.messages{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:8px}
.messages::-webkit-scrollbar{width:4px}
.messages::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
.empty-hint{text-align:center;color:#444;font-size:13px;margin-top:60px;line-height:1.8}
.msg-row{display:flex;flex-direction:column;max-width:85%}
.msg-row.mine{align-self:flex-end;align-items:flex-end}
.msg-row.other{align-self:flex-start;align-items:flex-start}
.msg-sender{font-size:11px;color:#888;margin-bottom:2px;padding:0 6px}
.msg-bubble{padding:8px 12px;border-radius:12px;font-size:14px;line-height:1.5;word-break:break-word;white-space:pre-wrap}
.mine .msg-bubble{background:#2b3d8c;border-bottom-right-radius:4px}
.other .msg-bubble{background:#2a2a2a;border-bottom-left-radius:4px}
.msg-bubble img{max-width:260px;max-height:300px;border-radius:8px;display:block;cursor:pointer}
.msg-bubble .file-attach{display:flex;align-items:center;gap:8px;background:#1a1a1a;border-radius:8px;padding:10px 12px}
.file-attach .file-icon{font-size:24px}
.file-attach .file-info{display:flex;flex-direction:column;gap:2px;min-width:0}
.file-attach .file-name{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file-attach .file-size{font-size:11px;color:#777}
.file-attach a{color:#7b8cff;font-size:12px;text-decoration:none;flex-shrink:0}
.file-attach a:hover{text-decoration:underline}
.msg-time{font-size:10px;color:#555;margin-top:2px;padding:0 6px}
.input-area{padding:10px 16px;background:#1a1a1a;border-top:1px solid #2a2a2a;display:flex;gap:8px;align-items:flex-end;flex-shrink:0}
.input-area textarea{flex:1;background:#222;border:1px solid #333;color:#e0e0e0;border-radius:8px;padding:10px 12px;font-size:14px;font-family:inherit;resize:none;max-height:100px;outline:none;line-height:1.4}
.input-area textarea:focus{border-color:#5b7cff}
.btn-icon{width:38px;height:38px;background:#222;border:1px solid #333;color:#aaa;border-radius:8px;font-size:18px;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center}
.btn-icon:hover{background:#333}
.btn-send{width:56px;height:38px;background:#3a5ae0;border:none;color:#fff;border-radius:8px;font-size:13px;cursor:pointer;flex-shrink:0}
.btn-send:hover{background:#4b6bf0}
.btn-send:disabled{opacity:0.4;cursor:default}
#file-input{display:none}
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{background:#1a1a1a;border:1px solid #333;border-radius:16px;padding:28px 24px;max-width:360px;width:90%;text-align:center;display:flex;flex-direction:column;gap:16px}
.modal h2{font-size:18px}
.modal .qr-wrap{background:#fff;border-radius:12px;padding:12px;display:inline-block;align-self:center}
.modal .qr-wrap canvas,.modal .qr-wrap img{display:block}
.modal .pin-display{font-size:32px;letter-spacing:8px;font-family:monospace;color:#ffcc00;font-weight:700}
.modal .link-row{display:flex;gap:8px}
.modal .link-row input{flex:1;background:#222;border:1px solid #333;color:#ccc;border-radius:6px;padding:8px 10px;font-size:12px;outline:none;font-family:monospace}
.modal .link-row button{font-size:12px;padding:6px 12px;white-space:nowrap}
.modal .hint{font-size:12px;color:#777}
.modal .btn-row{display:flex;gap:8px}
.modal .btn-row button{flex:1}
.toast{position:fixed;bottom:100px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:8px 18px;border-radius:20px;font-size:13px;opacity:0;pointer-events:none;transition:opacity .3s;z-index:300}
.toast.show{opacity:1}
.room-item{background:#1a1a1a;border:1px solid #2a2a2a;border-radius:10px;padding:12px 14px;display:flex;align-items:center;gap:12px;cursor:pointer;transition:border-color .15s}
.room-item:hover{border-color:#3a5ae0}
.room-item .room-id{font-family:monospace;font-size:14px;font-weight:600;color:#7b8cff;min-width:60px}
.room-item .room-meta{flex:1;display:flex;gap:10px;font-size:11px;color:#666;flex-wrap:wrap}
.room-item .room-meta span{white-space:nowrap}
.room-item .btn-join-sm{font-size:11px;padding:4px 12px;background:#3a5ae0;color:#fff;border:none;border-radius:6px;cursor:pointer;flex-shrink:0}
.room-item .btn-join-sm:hover{background:#4b6bf0}
.room-list-empty{text-align:center;color:#444;font-size:12px;padding:16px 0}
#room-list::-webkit-scrollbar{width:3px}
#room-list::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
.github-link{position:fixed;top:12px;right:16px;color:#555;z-index:100;transition:color .15s;text-decoration:none;display:flex;align-items:center}
.github-link:hover{color:#aaa}
.app-footer{position:fixed;bottom:0;left:0;right:0;display:flex;justify-content:center;gap:12px;padding:10px 0;font-size:12px;color:#555;background:linear-gradient(transparent,#111 50%);z-index:50}
.app-footer a{color:#555;text-decoration:none;transition:color .15s}
.app-footer a:hover{color:#aaa}
body.is-joining #room-list-section{display:none!important}
body.is-joining #app-footer{display:none!important}
@media(max-width:500px){.header{padding:8px 12px}.messages{padding:8px 10px}.input-area{padding:8px 10px;gap:6px}.msg-bubble img{max-width:200px;max-height:240px}.landing h1{font-size:24px}}
.uploading .btn-icon{opacity:.5;pointer-events:none}
.uploading .btn-icon::after{content:'';position:absolute;width:18px;height:18px;border:2px solid #555;border-top-color:#7b8cff;border-radius:50%;animation:spin .6s linear infinite}
.btn-icon{position:relative}
@keyframes spin{to{transform:rotate(360deg)}}
.scroll-bottom{position:fixed;bottom:70px;left:50%;transform:translateX(-50%);background:#3a5ae0;color:#fff;border:none;border-radius:20px;padding:6px 16px;font-size:12px;cursor:pointer;z-index:100;display:none;box-shadow:0 2px 8px rgba(0,0,0,.4)}
.scroll-bottom:hover{background:#4b6bf0}

/* === New Features CSS === */
/* Drag & drop */
.drop-overlay{display:none;position:fixed;inset:0;background:rgba(59,90,224,.15);border:3px dashed #3a5ae0;z-index:150;align-items:center;justify-content:center;font-size:18px;color:#3a5ae0;pointer-events:none}
body.drag-over .drop-overlay{display:flex}
body.light-theme .drop-overlay{background:rgba(59,90,224,.08)}
/* Reply quote bar */
.reply-quote{background:#1a1a1a;border-left:3px solid #3a5ae0;border-radius:4px;padding:6px 10px;margin:0 16px 6px;font-size:12px;color:#888;display:none;align-items:center;gap:8px}
.reply-quote .quote-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.reply-quote .quote-close{background:none;border:none;color:#666;cursor:pointer;font-size:16px;padding:0 4px}
body.light-theme .reply-quote{background:#f0f0f0;color:#666}
/* Reply button */
.msg-row{position:relative}
.msg-row .reply-btn{display:none;position:absolute;top:-7px;font-size:10px;background:#222;border:1px solid #333;color:#888;border-radius:4px;padding:1px 7px;cursor:pointer;z-index:2}
.msg-row.other .reply-btn{left:4px}
.msg-row.mine .reply-btn{right:4px}
.msg-row:hover .reply-btn{display:block}
body.light-theme .msg-row .reply-btn{background:#eee;border-color:#ccc;color:#666}
/* Markdown */
.msg-bubble strong{font-weight:700}
.msg-bubble em{font-style:italic}
.msg-bubble code{background:rgba(255,255,255,.1);padding:1px 5px;border-radius:3px;font-family:monospace;font-size:.9em}
.msg-bubble pre{background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:8px 12px;overflow-x:auto;margin:4px 0}
.msg-bubble pre code{background:none;padding:0;font-size:12px}
body.light-theme .msg-bubble code{background:rgba(0,0,0,.06)}
body.light-theme .msg-bubble pre{background:#f0f0f0;border-color:#ddd}
/* Theme toggle button */
.theme-toggle{position:fixed;top:12px;left:16px;z-index:100;width:30px;height:30px;font-size:15px;background:#222;border:1px solid #333;color:#888;border-radius:8px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.theme-toggle:hover{color:#ccc}
body.light-theme .theme-toggle{background:#eee;border-color:#ccc;color:#666}
body.light-theme .theme-toggle:hover{color:#333}
/* Light theme overrides */
body.light-theme{background:#f5f5f5;color:#222}
body.light-theme .header{background:#fff;border-color:#ddd}
body.light-theme .landing .sub{color:#666}
body.light-theme .card{background:#fff;border-color:#ddd}
body.light-theme .card label{color:#666}
body.light-theme .card input,.card select{background:#f5f5f5;border-color:#ccc;color:#222}
body.light-theme .btn-secondary{background:#eee;color:#222;border-color:#ccc}
body.light-theme .btn-secondary:hover{background:#ddd}
body.light-theme .btn-danger{background:#ffeeee;color:#c44;border-color:#fcc}
body.light-theme .btn-danger:hover{background:#ffe0e0}
body.light-theme .divider{color:#999}
body.light-theme .divider::before,.divider::after{border-color:#ddd}
body.light-theme .chat{background:#f5f5f5}
body.light-theme .messages{background:#f5f5f5}
body.light-theme .messages::-webkit-scrollbar-thumb{background:#ccc}
body.light-theme .other .msg-bubble{background:#f0f0f0}
body.light-theme .mine .msg-bubble{background:#dde4ff;color:#222}
body.light-theme .msg-sender{color:#888}
body.light-theme .msg-time{color:#999}
body.light-theme .msg-bubble .file-attach{background:#f5f5f5}
body.light-theme .file-attach .file-name{color:#333}
body.light-theme .file-attach .file-size{color:#999}
body.light-theme .input-area{background:#fff;border-color:#ddd}
body.light-theme .input-area textarea{background:#f5f5f5;border-color:#ccc;color:#222}
body.light-theme .btn-icon{background:#eee;border-color:#ccc;color:#666}
body.light-theme .btn-icon:hover{background:#ddd}
body.light-theme .empty-hint{color:#ccc}
body.light-theme .app-footer{background:linear-gradient(transparent,#f5f5f5 50%)}
body.light-theme .app-footer a{color:#999}
body.light-theme .header .room-tag{background:#e8ecff;color:#3a5ae0}
body.light-theme .header .ttl-info{color:#999}
body.light-theme .modal{background:#fff;border-color:#ddd}
body.light-theme .modal .link-row input{background:#f5f5f5;border-color:#ccc;color:#222}
body.light-theme .modal .hint{color:#999}
body.light-theme .modal .pin-display{color:#c96}
body.light-theme .toast{background:#333;color:#fff}
body.light-theme .room-item{background:#fff;border-color:#ddd}
body.light-theme .room-item:hover{border-color:#3a5ae0}
body.light-theme .room-item .room-meta{color:#999}
body.light-theme .room-list-empty{color:#ccc}
</style>
</head>
<body>
<a href="https://github.com/ruodeng/chat" target="_blank" rel="noopener" class="github-link" title="GitHub"><svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg></a>
<div class="app" id="app">
<div class="landing" id="view-landing">
<h1 id="landing-title" data-i18n="title">Temporary Chat</h1>
<p class="sub" id="landing-sub" data-i18n="subtitle">Create a room, share link &amp; PIN<br>No registration, auto-destroy</p>
<div class="card" id="create-card">
<label data-i18n="ttlLabel">Message lifetime (auto-destroy after inactivity)</label>
<select id="ttl-select">
<option value="1" selected data-i18n="ttl1">1 hour</option>
<option value="6" data-i18n="ttl6">6 hours</option>
<option value="12" data-i18n="ttl12">12 hours</option>
<option value="24" data-i18n="ttl24">24 hours</option>
</select>
<button class="btn btn-primary" id="btn-create" data-i18n="btnCreate">+ Create Room</button>
</div>
<div class="card" id="join-card">
<div class="divider" id="join-divider" data-i18n="divider">or join existing room</div>
<label data-i18n="labelRoomId">Room ID</label>
<input id="join-room-id" data-i18n-ph="phRoomId" placeholder="e.g. abc123" maxlength="10" autocomplete="off">
<label data-i18n="labelPin">4-digit PIN</label>
<input id="join-pin" type="text" data-i18n-ph="phPin" placeholder="e.g. 4829" maxlength="4" autocomplete="off" inputmode="numeric" pattern="[0-9]*">
<div id="turnstile-container" style="display:none;margin:8px 0;"></div>
<div id="join-error" style="display:none;font-size:13px;color:#e88;text-align:center;"></div>
<button class="btn btn-primary" id="btn-join" data-i18n="btnJoin">Join Room</button>
<a href="/" class="back-link" id="back-create" data-i18n="backCreate">&larr; Create your own room</a>
</div>
<div class="room-list-section" id="room-list-section" style="width:100%;max-width:360px;">
<div class="divider" data-i18n="orJoin">or join an existing room</div>
<div id="room-list" style="display:flex;flex-direction:column;gap:8px;max-height:240px;overflow-y:auto;"></div>
</div>
</div>
<div class="chat" id="view-chat">
<div class="header">
<a href="/" class="title" data-i18n="chatTitle" style="text-decoration:none;color:inherit">Chat Room</a>
<span class="room-tag" id="room-tag"></span>
<span class="ttl-info" id="ttl-info"></span>
<span class="spacer"></span>
<button class="btn-secondary" id="btn-share" data-i18n="btnShare" style="font-size:12px;padding:5px 10px;">Share</button>
<button class="btn-danger" id="btn-leave" data-i18n="btnLeave" style="font-size:12px;padding:5px 10px;">Leave</button>
</div>
<div class="messages" id="messages">
<div class="empty-hint" id="empty-hint"><span data-i18n="emptyHint">&#x1f44b; Send a message to start chatting</span><br><span style="font-size:11px" data-i18n="emptySub">Text, images, files | Files auto-upload on selection | Ctrl+V to paste image</span></div>
</div>
<div class="reply-quote" id="reply-quote"><span class="quote-text" id="quote-text"></span><button class="quote-close" id="quote-close">&times;</button></div>
<div class="input-area">
<button class="btn-icon" id="btn-attach" title="&#x1f4ce;" aria-label="Attach file">&#x1f4ce;</button>
<textarea id="text-input" rows="1" data-i18n-ph="phInput" placeholder="Type a message... (Enter to send)"></textarea>
<button class="btn-send" id="btn-send" data-i18n="btnSend" disabled>Send</button>
</div>
</div>
<div class="modal-overlay" id="share-modal" role="dialog" aria-modal="true" aria-label="Share Room">
<div class="modal">
<h2 data-i18n="shareTitle">Share Room</h2>
<p style="font-size:13px;color:#888" data-i18n="shareDesc">Scan QR code or send link</p>
<div class="qr-wrap" id="qr-container"></div>
<div class="pin-display" id="pin-display"></div>
<div class="link-row">
<input id="share-link" readonly onclick="this.select()">
<button class="btn-secondary" id="btn-copy-link" data-i18n="btnCopy">Copy</button>
</div>
<p class="hint" data-i18n="shareHint">Send both the link and PIN to your contact</p>
<div class="btn-row">
<button class="btn btn-secondary" id="btn-close-share" data-i18n="btnClose">Close</button>
</div>
</div>
</div>
</div>
<div class="drop-overlay" id="drop-overlay">Drop files here</div>
<div class="app-footer" id="app-footer"><a href="/about" data-i18n="footerAbout">About</a><span>|</span><a href="/privacy" data-i18n="footerPrivacy">Privacy</a><span>|</span><a href="https://github.com/ruodeng/chat" target="_blank">GitHub</a></div>
<button class="scroll-bottom" id="scroll-bottom">&#x2193; New messages</button>
<input type="file" id="file-input" multiple>
<script src="https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js"><\/script>
<script id="i18n-data" type="application/json">${JSON.stringify(TRANSLATIONS)}<\/script>
<script>
const T=JSON.parse(document.getElementById('i18n-data').textContent);
const lang=(navigator.language||navigator.browserLanguage||'en').toLowerCase();
const t=k=>(T[lang]||T[lang.split('-')[0]]||T.en)[k]||T.en[k]||k;
function translateError(d){if(d.errorCode){const m=(k,p)=>{let s=t(k);for(const[k2,v]of Object.entries(p))s=s.replace('{'+k2+'}',v);return s};switch(d.errorCode){case'CREATE_COOLDOWN':return m('errCreateCooldown',{s:d.wait});case'CREATE_BLACKLISTED':case'CREATE_RATE_LIMIT':return m('errCreateBlacklisted',{m:d.remaining||60});case'JOIN_COOLDOWN':return m('errCooldown',{s:d.wait});case'JOIN_BLACKLISTED':case'JOIN_RATE_LIMIT':return m('errBlacklisted',{m:d.remaining||30});case'CREATE_NEED_VERIFY':case'JOIN_NEED_VERIFY':return t('errNeedVerify');case'VERIFY_FAILED':return t('errVerifyFail');case'WRONG_PIN':return d.remaining!=null?m('errWrongAttempts',{n:d.remaining}):t('toastPinError');case'ROOM_NOT_FOUND':return t('errRoomNotFound');case'EMPTY_MESSAGE':return t('errEmptyMsg');case'FILE_NOT_FOUND':return t('errFileNotFound');case'MESSAGE_TOO_LONG':return t('errMessageTooLong');case'FILE_TOO_LARGE':return t('errFileTooLarge')}}return d.error||t('toastNetError')}
document.querySelectorAll('[data-i18n]').forEach(el=>{const k=el.getAttribute('data-i18n');if(T.en[k])el.innerHTML=t(k)});
document.querySelectorAll('[data-i18n-ph]').forEach(el=>{const k=el.getAttribute('data-i18n-ph');if(T.en[k])el.placeholder=t(k)});
let roomId=null,roomPin=null,roomTtl=1,myName='',lastTs=0,renderedIds=new Set(),pollingTimer=null,joinFailCount=0,turnstileEnabled=false,turnstileToken=null,turnstileWidgetId=null,createCooldownTimer=null,joinCooldownTimer=null,lastActivityAt=0,countdownTimer=null,pollInterval=2000,pollMaxInterval=10000,pollStep=1500,blobUrls=[],fetching=0,audioCtx=null,replyTarget=null;
const $=s=>document.querySelector(s),landingView=$('#view-landing'),chatView=$('#view-chat'),messagesEl=$('#messages'),textInput=$('#text-input'),fileInput=$('#file-input'),btnSend=$('#btn-send'),roomTag=$('#room-tag'),shareModal=$('#share-modal');
let theme=(()=>{try{return localStorage.getItem('theme')||'dark'}catch{return'dark'}})();if(theme==='light'){document.body.classList.add('light-theme');document.querySelector('#btn-theme').innerHTML='&#x263D;'}else{document.querySelector('#btn-theme').innerHTML='&#x2600;'}document.querySelector('#btn-theme').addEventListener('click',()=>{theme=theme==='dark'?'light':'dark';document.body.classList.toggle('light-theme',theme==='light');document.querySelector('#btn-theme').innerHTML=theme==='light'?'&#x263D;':'&#x2600;';try{localStorage.setItem('theme',theme)}catch{}});
// Drag-and-drop
let dragCounter=0;
document.addEventListener('dragenter',e=>{e.preventDefault();dragCounter++;if(chatView.classList.contains('active'))document.body.classList.add('drag-over')});
document.addEventListener('dragleave',e=>{e.preventDefault();dragCounter--;if(dragCounter<=0){dragCounter=0;document.body.classList.remove('drag-over')}});
document.addEventListener('dragover',e=>{e.preventDefault()});
document.addEventListener('drop',e=>{e.preventDefault();dragCounter=0;document.body.classList.remove('drag-over');if(!chatView.classList.contains('active'))return;const dfs=e.dataTransfer?.files;if(dfs&&dfs.length){for(const f of dfs)sendFile(f)}});
// Sound notification
function playBeep(){try{if(!audioCtx)audioCtx=new(window.AudioContext||window.webkitAudioContext)();const o=audioCtx.createOscillator(),g=audioCtx.createGain();o.type='sine';o.frequency.value=880;g.gain.value=0.08;o.connect(g);g.connect(audioCtx.destination);o.start();setTimeout(()=>{o.stop();g.disconnect()},70)}catch{}}
// Markdown parser
function parseMarkdown(tx){tx=escapeHtml(tx);tx=tx.replace(/\\*\\*(.+?)\\*\\*/g,'<strong>$1</strong>');tx=tx.replace(/\\*(.+?)\\*/g,'<em>$1</em>');tx=tx.replace(/\x60(.+?)\x60/g,'<code>$1</code>');return tx}
// Reply functions
function showReply(id,sender,tx){replyTarget=id;$('#quote-text').textContent=sender+': '+(tx||'(file)');$('#reply-quote').style.display='flex';textInput.focus()}
const qc=$('#quote-close');if(qc)qc.addEventListener('click',()=>{replyTarget=null;$('#reply-quote').style.display='none'});

function toast(m){let tEl=$('.toast');if(!tEl){tEl=document.createElement('div');tEl.className='toast';document.body.appendChild(tEl)}tEl.textContent=m;tEl.classList.add('show');clearTimeout(tEl._tid);tEl._tid=setTimeout(()=>tEl.classList.remove('show'),1800)}
function resetPolling(){pollInterval=2000;clearInterval(pollingTimer);pollingTimer=setInterval(fetchMessages,pollInterval)}
function getRoomFromURL(){const m=location.pathname.match(/^\\/room\\/([a-z0-9]+)/);if(m)return m[1];return null}
function saveRoomLocal(id,pin,ttlHours){try{const rooms=JSON.parse(localStorage.getItem('sc-rooms')||'[]');const idx=rooms.findIndex(r=>r.id===id);if(idx>=0){rooms[idx].pin=pin;if(ttlHours)rooms[idx].ttlHours=ttlHours}else{rooms.push({id,pin,joinedAt:Date.now(),ttlHours:ttlHours||1})}localStorage.setItem('sc-rooms',JSON.stringify(rooms))}catch{}}
function getSavedRooms(){try{const all=JSON.parse(localStorage.getItem('sc-rooms')||'[]');const now=Date.now();const fresh=all.filter(r=>now-r.joinedAt<(r.ttlHours||1)*7200000);if(fresh.length!==all.length)localStorage.setItem('sc-rooms',JSON.stringify(fresh));return fresh}catch{return[]}}
async function doCreateRoom(){try{const ttl=parseInt($('#ttl-select').value)||1;const body={ttl};if(turnstileToken){body.turnstile=turnstileToken;turnstileToken=null}const res=await fetch('/api/room/create',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await res.json();if(res.ok){resetJoinForm();roomTtl=data.ttlHours||1;saveRoomLocal(data.roomId,data.pin,data.ttlHours);joinAndEnter(data.roomId,data.pin);return}if(data.blacklisted){showJoinError(translateError(data));startCreateCooldown(data.retryAfter);return}if(data.retryAfter){showJoinError(translateError(data));startCreateCooldown(data.retryAfter);return}if(data.requireTurnstile){showJoinError(translateError(data));await maybeShowTurnstile();$('#btn-create').textContent=t('btnVerifyCreate');return}toast(translateError(data))}catch{toast(t('toastNetError'))}}
function startCreateCooldown(ms){const btn=$('#btn-create');btn.disabled=true;clearInterval(createCooldownTimer);const end=Date.now()+ms;const tick=()=>{const left=Math.ceil((end-Date.now())/1000);if(left<=0){btn.disabled=false;btn.textContent=t('btnCreate');showJoinError('');clearInterval(createCooldownTimer);return}const m=Math.floor(left/60),s=left%60;btn.textContent=m?m+t('btnMinRetry')+s+t('btnSecRetry'):s+t('btnRetry')};tick();createCooldownTimer=setInterval(tick,1000)}
$('#btn-create').addEventListener('click',doCreateRoom);
$('#btn-join').addEventListener('click',()=>{const id=$('#join-room-id').value.trim().toLowerCase(),pin=$('#join-pin').value.trim();if(!id||pin.length!==4)return toast(t('phNeedRoomId'));joinAndEnter(id,pin)});
$('#join-pin').addEventListener('keydown',e=>{if(e.key==='Enter')$('#btn-join').click()});
$('#join-room-id').addEventListener('keydown',e=>{if(e.key==='Enter')$('#join-pin').focus()});
function showJoinError(m){const el=$('#join-error');el.textContent=m;el.style.display=m?'':'none'}
function startCooldown(ms,btnText){const btn=$('#btn-join');btn.disabled=true;clearInterval(joinCooldownTimer);const end=Date.now()+ms;const tick=()=>{const left=Math.ceil((end-Date.now())/1000);if(left<=0){btn.disabled=false;btn.textContent=btnText;showJoinError('');clearInterval(joinCooldownTimer);return}const m=Math.floor(left/60),s=left%60;btn.textContent=m?m+t('btnMinRetry')+s+t('btnSecRetry'):s+t('btnRetry');showJoinError(t('errWait')+(m?m+t('btnMinRetry'):'')+s+t('errSecRetry'))};tick();joinCooldownTimer=setInterval(tick,1000)}
function resetJoinForm(){joinFailCount=0;clearInterval(joinCooldownTimer);$('#btn-join').disabled=false;$('#btn-join').textContent=t('btnJoin');showJoinError('');$('#turnstile-container').style.display='none';turnstileToken=null;if(turnstileWidgetId)turnstile.reset(turnstileWidgetId)}
async function loadTurnstile(){if(window.turnstile)return;return new Promise(r=>{const s=document.createElement('script');s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';s.onload=r;document.head.appendChild(s)})}
async function maybeShowTurnstile(){if(!turnstileEnabled)return;await loadTurnstile();$('#turnstile-container').style.display='';if(!turnstileWidgetId){turnstileWidgetId=window.turnstile.render('#turnstile-container',{sitekey:turnstileSiteKey,callback:tk=>{turnstileToken=tk},'expired-callback':()=>{turnstileToken=null},theme:'dark'})}else{window.turnstile.reset(turnstileWidgetId)}}
async function joinAndEnter(id,pin){const body={pin};if(turnstileToken){body.turnstile=turnstileToken;turnstileToken=null}try{const res=await fetch('/api/room/'+id+'/join',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await res.json();if(res.ok){resetJoinForm();myName=d.name;try{const ir=await fetch('/api/room/'+id+'/info');const info=await ir.json();roomTtl=info.ttlHours||1}catch{roomTtl=1}saveRoomLocal(id,pin,roomTtl);enterRoom(id,pin);return}joinFailCount=d.fails||joinFailCount;if(d.errorCode==='ROOM_NOT_FOUND'){removeRoomLocal(id);toast(translateError(d));return}if(d.blacklisted){showJoinError(translateError(d));startCooldown(d.retryAfter,t('btnJoin'));return}if(d.retryAfter&&!d.requireTurnstile){showJoinError(translateError(d));startCooldown(d.retryAfter,t('btnJoin'));return}if(d.requireTurnstile){showJoinError(translateError(d));await maybeShowTurnstile();$('#btn-join').textContent=t('btnVerifyJoin');return}showJoinError(translateError(d));$('#join-pin').value='';$('#join-pin').focus()}catch{toast(t('toastNetError'))}}
function enterRoom(id,pin){roomId=id;roomPin=pin;sessionStorage.setItem('roomId',id);sessionStorage.setItem('roomPin',pin);history.replaceState(null,'','/room/'+id);landingView.style.display='none';chatView.classList.add('active');$('#app-footer').style.display='none';$('#scroll-bottom').style.display='none';roomTag.textContent='#'+id;lastTs=0;renderedIds.clear();messagesEl.innerHTML='<div class="empty-hint"><span>'+t('emptyHint')+'</span><br><span style="font-size:11px">'+t('emptySub')+'</span></div>';fetchMessages();if(pollingTimer)clearInterval(pollingTimer);pollInterval=2000;pollingTimer=setInterval(fetchMessages,pollInterval);if(countdownTimer)clearInterval(countdownTimer);countdownTimer=setInterval(()=>{if(!lastActivityAt)return;const left=Math.max(0,(lastActivityAt+roomTtl*3600000)-Date.now());if(left<=0){$('#ttl-info').textContent=t('toastExpired');return}const h=Math.floor(left/3600000),m=Math.floor((left%3600000)/60000),s=Math.floor((left%60000)/1000);$('#ttl-info').textContent=h>0?h+':'+String(m).padStart(2,'0')+':'+String(s).padStart(2,'0'):m+':'+String(s).padStart(2,'0')},1000)}
messagesEl.addEventListener('scroll',()=>{const el=messagesEl;const atBottom=el.scrollHeight-el.scrollTop-el.clientHeight<80;$('#scroll-bottom').style.display=atBottom?'none':''});
$('#scroll-bottom').addEventListener('click',()=>{messagesEl.scrollTop=messagesEl.scrollHeight;$('#scroll-bottom').style.display='none'});
$('#btn-leave').addEventListener('click',()=>{if(!confirm(t('confirmLeave')))return;if(pollingTimer)clearInterval(pollingTimer);if(countdownTimer)clearInterval(countdownTimer);blobUrls.forEach(u=>URL.revokeObjectURL(u));blobUrls=[];sessionStorage.removeItem('roomId');sessionStorage.removeItem('roomPin');roomId=null;roomPin=null;myName='';lastActivityAt=0;history.replaceState(null,'','/');chatView.classList.remove('active');landingView.style.display='';$('#app-footer').style.display='';$('#scroll-bottom').style.display='none';loadRoomList()});
$('#btn-share').addEventListener('click',()=>{const link=location.origin+'/room/'+roomId;$('#share-link').value=link;$('#pin-display').textContent=roomPin;const qr=$('#qr-container');qr.innerHTML='';if(typeof QRCode!=='undefined'){new QRCode(qr,{text:link,width:180,height:180,colorDark:'#000',colorLight:'#fff'})}else{qr.innerHTML='<p style="color:#888;font-size:13px">'+t('qrFail')+'<br>'+t('qrFailSub')+'</p>'}shareModal.classList.add('show')});
$('#btn-close-share').addEventListener('click',()=>shareModal.classList.remove('show'));
shareModal.addEventListener('click',e=>{if(e.target===shareModal)shareModal.classList.remove('show')});
$('#btn-copy-link').addEventListener('click',()=>{const link=$('#share-link').value;const text=t('chatTitle')+': '+link+'\\nPIN: '+roomPin;navigator.clipboard.writeText(text).then(()=>toast(t('toastCopied')))});
$('#btn-attach').addEventListener('click',()=>fileInput.click());
fileInput.addEventListener('change',async()=>{const files=[...fileInput.files];fileInput.value='';for(const f of files)await sendFile(f)});
document.addEventListener('paste',e=>{if(document.activeElement===textInput)return;if(!chatView.classList.contains('active'))return;const items=e.clipboardData?.items;if(!items)return;for(const item of items){if(item.type.startsWith('image/')){e.preventDefault();sendFile(item.getAsFile())}else if(item.kind==='file'){e.preventDefault();sendFile(item.getAsFile())}}});
async function sendFile(file){const inputArea=$('.input-area');inputArea.classList.add('uploading');const fd=new FormData();fd.append('pin',roomPin);fd.append('sender',myName);fd.append('file',file);try{const res=await fetch('/api/room/'+roomId+'/send',{method:'POST',body:fd});if(!res.ok){const d=await res.json().catch(()=>({}));toast(translateError(d))}else{lastActivityAt=Date.now();resetPolling();fetchMessages()}}catch{toast(t('toastNetError'))}inputArea.classList.remove('uploading')}
function updateSendButton(){btnSend.disabled=!textInput.value.trim().length}
textInput.addEventListener('input',()=>{updateSendButton();textInput.style.height='auto';textInput.style.height=Math.min(textInput.scrollHeight,100)+'px'});
async function sendMessage(){const text=textInput.value.trim();if(!text)return;if(replyTarget){text='~'+replyTarget+'~\n'+text;replyTarget=null;$('#reply-quote').style.display='none'}btnSend.disabled=true;textInput.value='';textInput.style.height='auto';updateSendButton();const fd=new FormData();fd.append('pin',roomPin);fd.append('sender',myName);fd.append('text',text);try{const res=await fetch('/api/room/'+roomId+'/send',{method:'POST',body:fd});if(!res.ok)toast(t('toastSendFail'));else{lastActivityAt=Date.now();resetPolling();fetchMessages()}}catch{toast(t('toastNetError'))}btnSend.disabled=false}
btnSend.addEventListener('click',sendMessage);
textInput.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage()}});
async function fetchMessages(){if(fetching||!roomId)return;fetching=1;try{const res=await fetch('/api/room/'+roomId+'/messages?since='+lastTs,{headers:{'X-Room-Pin':roomPin}});fetching=0;if(res.status===403||res.status===404){const d=await res.json();toast(translateError(d));return}const data=await res.json();if(data.lastActivityAt){lastActivityAt=data.lastActivityAt;if(data.ttlHours)roomTtl=data.ttlHours}const list=data.messages||data;if(list.length){const hint=messagesEl.querySelector('.empty-hint');if(hint)hint.remove();const wasAtBottom=messagesEl.scrollHeight-messagesEl.scrollTop-messagesEl.clientHeight<80;for(const msg of list){if(renderedIds.has(msg.id))continue;renderedIds.add(msg.id);if(msg.createdAt>lastTs)lastTs=msg.createdAt;renderMessage(msg);if(document.visibilityState==='hidden')playBeep()}if(wasAtBottom)messagesEl.scrollTop=messagesEl.scrollHeight;pollInterval=2000;clearInterval(pollingTimer);pollingTimer=setInterval(fetchMessages,pollInterval)}else{if(pollInterval<pollMaxInterval){pollInterval=Math.min(pollInterval+pollStep,pollMaxInterval);clearInterval(pollingTimer);pollingTimer=setInterval(fetchMessages,pollInterval)}}}catch{fetching=0;if(pollInterval<pollMaxInterval){pollInterval=Math.min(pollInterval+pollStep,pollMaxInterval);clearInterval(pollingTimer);pollingTimer=setInterval(fetchMessages,pollInterval)}}}
async function fetchFileBlob(url){const res=await fetch(url,{headers:{'X-Room-Pin':roomPin}});if(!res.ok)throw new Error('fetch failed');const blob=await res.blob();const u=URL.createObjectURL(blob);blobUrls.push(u);return u}
function downloadFile(msgId,fileName){fetch('/api/room/'+roomId+'/file/'+msgId,{headers:{'X-Room-Pin':roomPin}}).then(r=>{if(!r.ok)throw new Error();return r.blob()}).then(blob=>{const a=document.createElement('a');const u=URL.createObjectURL(blob);blobUrls.push(u);a.href=u;a.download=fileName||'download';document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(()=>{const i=blobUrls.indexOf(u);if(i>=0)blobUrls.splice(i,1);URL.revokeObjectURL(u)},60000)}).catch(()=>toast(t('errFileNotFound')))}
function renderMessage(msg){const isMine=msg.sender===myName,row=document.createElement('div');row.className='msg-row '+(isMine?'mine':'other');row.id='m-'+msg.id;const ts=new Date(msg.createdAt).toLocaleTimeString(navigator.language||'en',{hour:'2-digit',minute:'2-digit'});let bp=[];if(msg.text)bp.push(parseMarkdown(msg.text));if(msg.hasFile){const u='/api/room/'+roomId+'/file/'+msg.id;if(msg.type==='image'){bp.push('<img alt="'+escapeHtml(msg.fileName||'image')+'" loading="lazy" data-file-url="'+u+'">')}else{const sz=msg.fileSize?formatSize(msg.fileSize):'';bp.push('<div class="file-attach"><span class="file-icon">&#x1f4c4;</span><div class="file-info"><span class="file-name">'+escapeHtml(msg.fileName||'file')+'</span>'+(sz?'<span class="file-size">'+sz+'</span>':'')+'</div><a href="javascript:void(0)" data-download="'+msg.id+'" data-filename="'+escapeHtml(msg.fileName||'file')+'">Download</a></div>')}}row.innerHTML='<div class="msg-sender">'+escapeHtml(msg.sender)+'</div><div class="msg-bubble">'+bp.join('<div style="margin:4px 0"></div>')+'</div><div class="msg-time">'+ts+'</div>';messagesEl.appendChild(row);row.querySelectorAll('img[data-file-url]').forEach(img=>{fetchFileBlob(img.getAttribute('data-file-url')).then(url=>{img.src=url}).catch(()=>{img.alt='Failed to load'})});const rb=document.createElement('span');rb.className='reply-btn';rb.textContent='↩';rb.addEventListener('click',e=>{e.stopPropagation();showReply(msg.id,msg.sender,msg.text||'(file)')});row.appendChild(rb);
row.querySelectorAll('a[data-download]').forEach(a=>{a.addEventListener('click',()=>{downloadFile(a.dataset.download,a.dataset.filename)})})}
function escapeHtml(s){const d=document.createElement('div');d.textContent=s;return d.innerHTML}
function formatSize(b){if(!b)return'';if(b<1024)return b+' B';if(b<1024*1024)return(b/1024).toFixed(1)+' KB';return(b/(1024*1024)).toFixed(1)+' MB'}
let turnstileSiteKey='';
(async()=>{try{const r=await fetch('/api/turnstile/config');const d=await r.json();turnstileEnabled=d.enabled;turnstileSiteKey=d.siteKey}catch{}})();
const urlRoomId=getRoomFromURL();
function setLandingContext(isJoining){if(isJoining){document.body.classList.add('is-joining');$('#landing-title').textContent=t('joinTitle');$('#landing-sub').innerHTML=t('joinSub')+'<br><span style="font-size:11px;color:#555">'+t('joinNoPwd')+'</span>';$('#btn-join').textContent=t('btnJoin');$('#btn-join').className='btn btn-primary'}else{document.body.classList.remove('is-joining');$('#landing-title').textContent=t('title');$('#landing-sub').innerHTML=t('subtitle');$('#btn-join').textContent=t('btnJoin');$('#btn-join').className='btn btn-secondary';loadRoomList()}}
function loadRoomList(){const el=$('#room-list');if(!el)return;const saved=getSavedRooms();const now=Date.now();const active=[];saved.forEach(r=>{if(now-r.joinedAt<(r.ttlHours||1)*3600000){active.push(r)}else{removeRoomLocal(r.id)}});if(!active.length){el.innerHTML='<div class="room-list-empty">'+t('noRooms')+'</div>';return}el.innerHTML=active.map(r=>'<div class="room-item" data-room="'+r.id+'"><span class="room-id">#'+r.id+'</span><span class="room-meta"><span>...</span></span><button class="btn-join-sm" onclick="enterSavedRoom(\\''+r.id+'\\')">'+t('btnRoomJoin')+'</button></div>').join('');active.forEach(r=>{fetch('/api/room/'+r.id+'/info').then(res=>{if(!res.ok){removeRoomLocal(r.id);const item=el.querySelector('[data-room="'+r.id+'"]');if(item)item.remove();if(!el.querySelector('.room-item'))el.innerHTML='<div class="room-list-empty">'+t('noRooms')+'</div>';return}return res.json()}).then(info=>{if(!info)return;const item=el.querySelector('[data-room="'+info.roomId+'"]');if(!item)return;const meta=item.querySelector('.room-meta');const now=Date.now();const remaining=Math.max(0,(info.ttlHours||1)*3600000-(now-info.lastActivityAt));const mins=Math.floor(remaining/60000);const hrs=Math.floor(mins/60);const rem=mins%60;const ts=hrs>0?hrs+'h '+rem+'m':rem+'m';meta.innerHTML='<span>'+info.messageCount+' '+t('roomMsgs')+'</span><span>'+ts+' '+t('roomExpires')+'</span>'}).catch(()=>{})})}
function removeRoomLocal(id){try{const rooms=getSavedRooms().filter(r=>r.id!==id);localStorage.setItem('sc-rooms',JSON.stringify(rooms))}catch{}}
function enterSavedRoom(id){const rooms=getSavedRooms();const r=rooms.find(x=>x.id===id);if(r)joinAndEnter(r.id,r.pin);else toast(t('errRoomNotFound'))}
if(urlRoomId){const saved=getSavedRooms().find(r=>r.id===urlRoomId);if(saved){joinAndEnter(saved.id,saved.pin)}else{setLandingContext(true);const params=new URLSearchParams(location.search);const pin=params.get('pin');if(pin){joinAndEnter(urlRoomId,pin)}else{$('#join-room-id').value=urlRoomId;$('#join-pin').focus()}}}else{setLandingContext(false)}
<\/script>
</body>
</html>`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await handleRequest(request, env);
    if (request.url.includes('/api/')) {
      return addCorsHeaders(response, request);
    }
    return response;
  },
};
