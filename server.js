require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const session = require('express-session');
const SQLiteStoreFactory = require('better-sqlite3-session-store');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');
const TelegramBot = require('node-telegram-bot-api');

const PORT = Number(process.env.PORT || 3000);
const SITE_NAME = process.env.SITE_NAME || 'ЧАТ ВЕРХНЕГО УСЛОНА';
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const OTP_MODE = process.env.OTP_MODE || 'demo';

const db = new Database(path.join(__dirname, 'data', 'chat.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE NOT NULL,
  name TEXT,
  is_banned INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS otp_codes (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  system INTEGER DEFAULT 0,
  text TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id)
);
`);

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://cdn.socket.io"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
    }
  }
}));
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SQLiteStore = SQLiteStoreFactory(session);
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: new SQLiteStore({ client: db, expired: { clear: true, intervalMs: 900000 } }),
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 24 * 30 }
});
app.use(sessionMiddleware);

function normalizePhone(phone) {
  const cleaned = String(phone || '').replace(/[^\d+]/g, '');
  if (cleaned.startsWith('8') && cleaned.length === 11) return '+7' + cleaned.slice(1);
  if (cleaned.startsWith('7') && cleaned.length === 11) return '+' + cleaned;
  if (cleaned.startsWith('+7') && cleaned.length === 12) return cleaned;
  if (cleaned.startsWith('+') && cleaned.length >= 10 && cleaned.length <= 16) return cleaned;
  return null;
}

function randomCode() {
  return String(crypto.randomInt(100000, 999999));
}

async function sendSmsCode(phone, code) {
  if (botToken && adminChatId) {
    try {
      const bot = new TelegramBot(botToken);
      await bot.sendMessage(
        adminChatId,
        `🔐 Код входа для ${phone}: ${code}`
      );
      console.log(`Код отправлен в Telegram для ${phone}`);
      return;
    } catch (e) {
      console.error("Telegram code error:", e.message);
    }
  }

  console.log(`\n[КОД ВХОДА] ${phone}: ${code}\n`);
} 
  if (OTP_MODE === 'demo') {
    console.log(`\n[КОД ВХОДА] ${phone}: ${code}\n`);
    return;
  }
  // Подключите здесь SMS-провайдера: sms.ru, Twilio, SMSC, МТС Exolve и т.п.
  console.log(`[SMS MODE NOT CONFIGURED] ${phone}: ${code}`);
}

function currentUser(req) {
  if (!req.session.userId) return null;
  return db.prepare('SELECT id, phone, name, is_banned FROM users WHERE id = ?').get(req.session.userId);
}

app.get('/api/config', (req, res) => res.json({ siteName: SITE_NAME }));

app.get('/api/me', (req, res) => {
  const user = currentUser(req);
  res.json({ user: user && !user.is_banned ? user : null });
});

app.post('/api/request-code', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ error: 'Введите корректный номер телефона.' });

  const code = randomCode();
  const codeHash = await bcrypt.hash(code, 10);
  const expiresAt = Date.now() + 5 * 60 * 1000;

  db.prepare(`
    INSERT INTO otp_codes(phone, code_hash, expires_at, attempts)
    VALUES (?, ?, ?, 0)
    ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0
  `).run(phone, codeHash, expiresAt);

  await sendSmsCode(phone, code);
  res.json({ ok: true, message: OTP_MODE === 'demo' ? 'Код напечатан в консоли сервера.' : 'Код отправлен.' });
});

app.post('/api/verify-code', async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '').trim();
  const name = String(req.body.name || '').trim().slice(0, 40);

  if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Неверный номер или код.' });

  const row = db.prepare('SELECT * FROM otp_codes WHERE phone = ?').get(phone);
  if (!row || row.expires_at < Date.now()) return res.status(400).json({ error: 'Код истёк. Запросите новый.' });
  if (row.attempts >= 5) return res.status(429).json({ error: 'Слишком много попыток. Запросите новый код.' });

  const ok = await bcrypt.compare(code, row.code_hash);
  if (!ok) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?').run(phone);
    return res.status(400).json({ error: 'Неверный код.' });
  }

  db.prepare('DELETE FROM otp_codes WHERE phone = ?').run(phone);

  let user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (!user) {
    db.prepare('INSERT INTO users(phone, name) VALUES (?, ?)').run(phone, name || 'Участник');
    user = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  } else if (name && !user.name) {
    db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, user.id);
  }

  if (user.is_banned) return res.status(403).json({ error: 'Доступ ограничен администратором.' });

  req.session.userId = user.id;
  res.json({ ok: true, user: { id: user.id, phone: user.phone, name: user.name } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/messages', (req, res) => {
  const user = currentUser(req);
  if (!user || user.is_banned) return res.status(401).json({ error: 'Нужен вход.' });

  const messages = db.prepare(`
    SELECT m.id, m.text, m.created_at, m.system, u.name, u.phone
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    ORDER BY m.id DESC LIMIT 80
  `).all().reverse();

  res.json({ messages });
});

const server = app.listen(PORT, () => {
  console.log(`${SITE_NAME}: http://localhost:${PORT}`);
});

const io = new Server(server);
io.engine.use(sessionMiddleware);

io.on('connection', (socket) => {
  const req = socket.request;
  const user = req.session.userId ? db.prepare('SELECT id, phone, name, is_banned FROM users WHERE id = ?').get(req.session.userId) : null;

  if (!user || user.is_banned) {
    socket.emit('auth-error');
    socket.disconnect();
    return;
  }

  socket.on('message', (text) => {
    const clean = String(text || '').trim().slice(0, 1000);
    if (!clean) return;

    const fresh = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(user.id);
    if (!fresh || fresh.is_banned) return;

    const info = db.prepare('INSERT INTO messages(user_id, text) VALUES (?, ?)').run(user.id, clean);
    const msg = db.prepare(`
      SELECT m.id, m.text, m.created_at, m.system, u.name, u.phone
      FROM messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE m.id = ?
    `).get(info.lastInsertRowid);
    io.emit('message', msg);
  });
});

function systemMessage(text) {
  const info = db.prepare('INSERT INTO messages(system, text) VALUES (1, ?)').run(text);
  const msg = db.prepare('SELECT id, text, created_at, system FROM messages WHERE id = ?').get(info.lastInsertRowid);
  io.emit('message', msg);
}

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;

if (botToken && adminChatId) {
  const bot = new TelegramBot(botToken, { polling: true });

  function adminOnly(msg) {
    return String(msg.chat.id) === String(adminChatId);
  }

  bot.onText(/\/help/, (msg) => {
    if (!adminOnly(msg)) return;
    bot.sendMessage(msg.chat.id, 'Команды: /users, /ban +79990000000, /unban +79990000000, /broadcast текст');
  });

  bot.onText(/\/users/, (msg) => {
    if (!adminOnly(msg)) return;
    const users = db.prepare('SELECT phone, name, is_banned, created_at FROM users ORDER BY id DESC LIMIT 50').all();
    const text = users.length
      ? users.map(u => `${u.is_banned ? '⛔' : '✅'} ${u.phone} — ${u.name || 'без имени'} — ${u.created_at}`).join('\n')
      : 'Пользователей пока нет.';
    bot.sendMessage(msg.chat.id, text);
  });

  bot.onText(/\/ban\s+(.+)/, (msg, match) => {
    if (!adminOnly(msg)) return;
    const phone = normalizePhone(match[1]);
    if (!phone) return bot.sendMessage(msg.chat.id, 'Неверный номер.');
    db.prepare('UPDATE users SET is_banned = 1 WHERE phone = ?').run(phone);
    systemMessage(`Пользователь ${phone} заблокирован администратором.`);
    bot.sendMessage(msg.chat.id, `Заблокирован: ${phone}`);
  });

  bot.onText(/\/unban\s+(.+)/, (msg, match) => {
    if (!adminOnly(msg)) return;
    const phone = normalizePhone(match[1]);
    if (!phone) return bot.sendMessage(msg.chat.id, 'Неверный номер.');
    db.prepare('UPDATE users SET is_banned = 0 WHERE phone = ?').run(phone);
    bot.sendMessage(msg.chat.id, `Разблокирован: ${phone}`);
  });

  bot.onText(/\/broadcast\s+([\s\S]+)/, (msg, match) => {
    if (!adminOnly(msg)) return;
    const text = String(match[1] || '').trim().slice(0, 1000);
    if (!text) return;
    systemMessage(`📢 ${text}`);
    bot.sendMessage(msg.chat.id, 'Объявление отправлено в чат.');
  });

  console.log('Telegram-управление включено.');
} else {
  console.log('Telegram-управление выключено: добавьте TELEGRAM_BOT_TOKEN и TELEGRAM_ADMIN_CHAT_ID в .env');
}
