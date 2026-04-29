const express = require('express');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3456;
const TTL_OPTIONS = [1, 6, 12, 24]; // valid TTL hours
const TURNSTILE_SITE_KEY = process.env.TURNSTILE_SITE_KEY || '';
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY || '';
const DATA_DIR = path.join(__dirname, 'data');
const ROOMS_FILE = path.join(DATA_DIR, 'rooms.json');

// Rate limiting: per (ip, roomId) -> fail count
const failMap = new Map();   // key: `${ip}:${roomId}` -> { count, firstFail, lastFail }
const blacklist = new Map();  // key: ip -> { until }

// Rate limiting: room creation per IP
const createTracker = new Map();  // key: ip -> [timestamps...]
const createBlacklist = new Map(); // key: ip -> { until }

// Ensure data directory
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const names = ['Alice', 'Bob', 'Charlie', 'David', 'Eve', 'Frank', 'Grace',
  'Henry', 'Iris', 'Jack', 'Kate', 'Leo', 'Mia', 'Noah', 'Olivia',
  'Peter', 'Quinn', 'Rose', 'Sam', 'Tina', 'Umar', 'Vera', 'Will',
  'Xena', 'Yuki', 'Zoe'];

const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Persistence ---
function loadRooms() {
  try { return JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8')); }
  catch { return {}; }
}
function saveRooms(rooms) {
  fs.writeFileSync(ROOMS_FILE, JSON.stringify(rooms, null, 2), 'utf8');
}

// --- Helpers ---
function genRoomId() {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // no confusing chars
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[crypto.randomInt(chars.length)];
  return s;
}
function genPin() {
  return String(crypto.randomInt(1000, 9999));
}
function assignName(room, ip) {
  if (room.ipNames[ip]) return room.ipNames[ip];
  const used = new Set(Object.values(room.ipNames));
  for (const n of names) {
    if (!used.has(n)) { room.ipNames[ip] = n; return n; }
  }
  // All names taken, use IP
  const fallback = 'Guest' + (Object.keys(room.ipNames).length + 1);
  room.ipNames[ip] = fallback;
  return fallback;
}
function clientIp(req) {
  return req.ip.replace(/^::ffff:/, '');
}

// --- Cleanup expired rooms and stale rate limits ---
setInterval(() => {
  const rooms = loadRooms();
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(rooms)) {
    const room = rooms[id];
    const inactive = now - (room.lastActivityAt || room.createdAt);
    if (inactive > (room.ttlHours || 1) * 3600 * 1000) {
      delete rooms[id];
      changed = true;
    }
  }
  if (changed) saveRooms(rooms);
  // Cleanup stale fail map entries (>1h old) and expired blacklists
  for (const [k, v] of failMap) {
    if (now - v.lastFail > 3600_000) failMap.delete(k);
  }
  for (const [ip, v] of blacklist) {
    if (now > v.until) blacklist.delete(ip);
  }
  // Cleanup old creation timestamps and expired create blacklists
  for (const [ip, times] of createTracker) {
    const recent = times.filter(t => now - t < 600_000); // keep last 10 min
    if (recent.length) createTracker.set(ip, recent);
    else createTracker.delete(ip);
  }
  for (const [ip, v] of createBlacklist) {
    if (now > v.until) createBlacklist.delete(ip);
  }
}, 60_000);

// --- Create room (with rate limiting) ---
app.post('/api/room/create', async (req, res) => {
  const ip = clientIp(req);
  const now = Date.now();

  // Check creation blacklist
  const cbl = createBlacklist.get(ip);
  if (cbl && now < cbl.until) {
    const remaining = Math.ceil((cbl.until - now) / 1000 / 60);
    return res.status(429).json({
      error: `创建过于频繁，${remaining} 分钟后再试`,
      blacklisted: true,
      retryAfter: cbl.until - now,
    });
  }

  // Track: keep timestamps from last 10 minutes
  let times = createTracker.get(ip) || [];
  times = times.filter(t => now - t < 600_000);
  const recentCount = times.length;

  // Limit: 3 rooms per 10 minutes per IP
  if (recentCount >= 10) {
    createBlacklist.set(ip, { until: now + 3600_000 });
    return res.status(429).json({
      error: '创建过于频繁，已被限制 60 分钟',
      blacklisted: true,
      retryAfter: 3600_000,
    });
  }

  if (recentCount >= 3) {
    // Require Turnstile if configured
    if (TURNSTILE_SITE_KEY) {
      const token = req.body.turnstile;
      if (!token) {
        return res.status(403).json({
          error: '创建过于频繁，需要完成验证',
          requireTurnstile: true,
        });
      }
      const ok = await verifyTurnstile(token);
      if (!ok) {
        return res.status(403).json({
          error: '验证失败，请重试',
          requireTurnstile: true,
        });
      }
    } else {
      // Without Turnstile: enforce cooldown (oldest + 2 min)
      const cooldownEnd = times[0] + 120_000;
      if (now < cooldownEnd) {
        const wait = Math.ceil((cooldownEnd - now) / 1000);
        return res.status(429).json({
          error: `创建过于频繁，请等待 ${wait} 秒后再试`,
          retryAfter: cooldownEnd - now,
        });
      }
    }
  }

  // All checks passed: create room
  times.push(now);
  createTracker.set(ip, times);

  const rooms = loadRooms();
  const id = genRoomId();
  const pin = genPin();
  const ttl = TTL_OPTIONS.includes(req.body.ttl) ? req.body.ttl : 1;
  rooms[id] = {
    id,
    pin,
    ttlHours: ttl,
    createdAt: now,
    lastActivityAt: now,
    ipNames: {},
    messages: [],
  };
  saveRooms(rooms);
  res.json({ roomId: id, pin, ttlHours: ttl });
});

// --- Turnstile config (expose site key to frontend) ---
app.get('/api/turnstile/config', (_req, res) => {
  res.json({ enabled: !!TURNSTILE_SITE_KEY, siteKey: TURNSTILE_SITE_KEY });
});

async function verifyTurnstile(token) {
  if (!TURNSTILE_SECRET) return true; // not configured, skip
  try {
    const body = new URLSearchParams({ secret: TURNSTILE_SECRET, response: token });
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', body,
    });
    const data = await r.json();
    return data.success === true;
  } catch { return false; }
}

// --- Join room (verify PIN) with rate limiting ---
app.post('/api/room/:roomId/join', async (req, res) => {
  const rooms = loadRooms();
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });

  const ip = clientIp(req);
  const now = Date.now();
  const failKey = `${ip}:${req.params.roomId}`;

  // Check blacklist
  const bl = blacklist.get(ip);
  if (bl && now < bl.until) {
    const remaining = Math.ceil((bl.until - now) / 1000 / 60);
    return res.status(429).json({
      error: `尝试次数过多，已被暂时拉黑，${remaining} 分钟后重试`,
      blacklisted: true,
      retryAfter: bl.until - now,
    });
  }

  const fails = failMap.get(failKey) || { count: 0, firstFail: now, lastFail: 0 };

  // Prevent rapid-fire attempts: enforce cooldown between tries
  if (fails.count >= 3 && fails.count < 6) {
    const delays = [0, 0, 0, 5, 10, 30];
    const delay = (delays[fails.count] || 30) * 1000;
    const elapsed = now - fails.lastFail;
    if (elapsed < delay) {
      const wait = Math.ceil((delay - elapsed) / 1000);
      return res.status(429).json({
        error: `请等待 ${wait} 秒后再试`,
        retryAfter: delay - elapsed,
        fails: fails.count,
      });
    }
  }

  // If Turnstile is configured and fail count >= 3, require token
  if (TURNSTILE_SITE_KEY && fails.count >= 3) {
    const token = req.body.turnstile;
    if (!token) {
      return res.status(403).json({
        error: '密码错误次数过多，需要完成验证',
        requireTurnstile: true,
        fails: fails.count,
      });
    }
    const ok = await verifyTurnstile(token);
    if (!ok) {
      return res.status(403).json({
        error: '验证失败，请重试',
        requireTurnstile: true,
        fails: fails.count,
      });
    }
  }

  // Check PIN — correct password always works regardless of fail count
  if (req.body.pin === room.pin) {
    failMap.delete(failKey);
    const name = assignName(room, ip);
    saveRooms(rooms);
    return res.json({ ok: true, name });
  }

  // Wrong PIN: increment fail count
  fails.count++;
  fails.lastFail = now;
  failMap.set(failKey, fails);

  // Blacklist after 6 fails
  if (fails.count >= 6) {
    blacklist.set(ip, { until: now + 30 * 60_000 });
    return res.status(429).json({
      error: '尝试次数过多，已被拉黑 30 分钟',
      blacklisted: true,
      retryAfter: 30 * 60_000,
    });
  }

  const remaining = Math.max(0, 6 - fails.count);
  const msg = TURNSTILE_SITE_KEY && fails.count >= 3
    ? `密码错误，还需验证（剩余 ${remaining} 次机会）`
    : `密码错误，剩余 ${remaining} 次尝试机会`;

  res.status(403).json({
    error: msg,
    fails: fails.count,
    requireTurnstile: TURNSTILE_SITE_KEY && fails.count >= 3,
  });
});

// --- Get room info (no PIN needed for metadata) ---
app.get('/api/room/:roomId/info', (req, res) => {
  const rooms = loadRooms();
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });
  const senders = new Set(room.messages.map(m => m.sender));
  res.json({
    roomId: room.id,
    createdAt: room.createdAt,
    lastActivityAt: room.lastActivityAt,
    ttlHours: room.ttlHours || 1,
    online: senders.size,
    messageCount: room.messages.length,
  });
});

// --- Send message ---
app.post('/api/room/:roomId/send', upload.single('file'), (req, res) => {
  const rooms = loadRooms();
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });
  if (req.body.pin !== room.pin) return res.status(403).json({ error: '密码错误' });

  const ip = clientIp(req);
  const sender = (req.body.sender || '').trim().slice(0, 30) || assignName(room, ip);
  assignName(room, ip); // ensure assignment is saved
  const text = req.body.text?.trim() || null;
  const file = req.file;

  if (!text && !file) return res.status(400).json({ error: 'Empty message' });

  let type = 'text';
  if (file) {
    type = file.mimetype.startsWith('image/') ? 'image' : 'file';
  }

  const msg = {
    id: crypto.randomUUID(),
    sender,
    type,
    text,
    fileName: file?.originalname || null,
    fileData: file?.buffer ? file.buffer.toString('base64') : null,
    fileMime: file?.mimetype || null,
    fileSize: file?.size || null,
    createdAt: Date.now(),
  };
  room.messages.push(msg);
  room.lastActivityAt = Date.now();
  saveRooms(rooms);
  res.json({ ok: true, id: msg.id });
});

// --- Get messages ---
app.get('/api/room/:roomId/messages', (req, res) => {
  const rooms = loadRooms();
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });
  if (req.query.pin !== room.pin) return res.status(403).json({ error: '密码错误' });

  const since = parseInt(req.query.since) || 0;
  const filtered = room.messages.filter(m => m.createdAt > since);
  const list = filtered.map(m => ({
    id: m.id,
    sender: m.sender,
    type: m.type,
    text: m.text,
    fileName: m.fileName,
    fileSize: m.fileSize,
    hasFile: !!m.fileData,
    createdAt: m.createdAt,
  }));
  res.json(list);
});

// --- Download file ---
app.get('/api/room/:roomId/file/:msgId', (req, res) => {
  const rooms = loadRooms();
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });
  if (req.query.pin !== room.pin) return res.status(403).json({ error: '密码错误' });

  const msg = room.messages.find(m => m.id === req.params.msgId);
  if (!msg || !msg.fileData) return res.status(404).json({ error: 'Not found' });

  const data = Buffer.from(msg.fileData, 'base64');
  if (msg.type === 'image') {
    res.set('Content-Type', msg.fileMime);
    res.set('Content-Disposition', `inline; filename="${msg.fileName}"`);
  } else {
    res.set('Content-Type', msg.fileMime);
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(msg.fileName)}`);
  }
  res.send(data);
});

// --- Delete message ---
app.delete('/api/room/:roomId/message/:msgId', (req, res) => {
  const rooms = loadRooms();
  const room = rooms[req.params.roomId];
  if (!room) return res.status(404).json({ error: '房间不存在或已过期' });
  if (req.body.pin !== room.pin) return res.status(403).json({ error: '密码错误' });

  const i = room.messages.findIndex(m => m.id === req.params.msgId);
  if (i !== -1) room.messages.splice(i, 1);
  saveRooms(rooms);
  res.json({ ok: true });
});

// --- Serve room page (SPA handles routing) ---
app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function getLocalIPs() {
  const ips = [];
  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) ips.push(addr.address);
    }
  }
  return ips;
}

app.listen(PORT, '0.0.0.0', () => {
  const ips = getLocalIPs();
  console.log(`\n  Share Chat server running on:\n`);
  console.log(`    Local:   http://localhost:${PORT}`);
  for (const ip of ips) {
    console.log(`    Network: http://${ip}:${PORT}`);
  }
  console.log(`\n  Rooms expire after inactivity (default 1h).\n`);
});
