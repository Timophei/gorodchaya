// Авторизация через Telegram Login Widget — без пароля, без своей формы
// регистрации. Проверка подлинности данных от Telegram и сессия через
// подписанную cookie (HMAC), без базы сессий — все данные сессии лежат
// в самой cookie, сервер только проверяет подпись.
//
// Нужно на сервере (env):
//   TELEGRAM_BOT_TOKEN — токен бота от @BotFather
//   SESSION_SECRET     — любая длинная случайная строка (держит подписи cookie)
//
// Как получить TELEGRAM_BOT_TOKEN:
//   1. Написать @BotFather в Telegram → /newbot → следовать подсказкам.
//   2. Скопировать выданный токен (вида 123456:AAаа...).
//   3. Тому же боту отправить /setdomain и указать домен сайта БЕЗ https:// и
//      без пути — просто gorodchaya.ru. Без этого шага виджет входа работать
//      не будет вообще (Telegram привязывает виджет к конкретному домену).
const crypto = require('crypto');
const userStore = require('./userStore');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
if (!BOT_TOKEN) {
  console.log('TELEGRAM_BOT_TOKEN не задан — /api/auth/telegram будет отвечать 503, пока переменная не появится.');
}

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.log(`SESSION_SECRET не задан — сгенерирован временный на этот запуск: ${SESSION_SECRET}`);
  console.log('Задайте SESSION_SECRET в окружении, иначе все сессии слетают при каждом перезапуске сервера.');
}

const SESSION_COOKIE = 'cg_session';
const SESSION_MAX_AGE_DAYS = 30;
const AUTH_DATE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // отбрасываем данные входа старше суток (защита от повторного использования)

// Проверка подлинности данных от Telegram Login Widget по их алгоритму:
// https://core.telegram.org/widgets/login#checking-authorization
function verifyTelegramAuth(data) {
  if (!BOT_TOKEN) return false;
  if (!data || typeof data !== 'object' || !data.hash || !data.id || !data.auth_date) return false;

  const { hash, ...fields } = data;
  const checkString = Object.keys(fields)
    .filter((k) => fields[k] !== undefined && fields[k] !== null)
    .sort()
    .map((k) => `${k}=${fields[k]}`)
    .join('\n');

  const secretKey = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');

  const a = Buffer.from(computedHash, 'hex');
  const b = Buffer.from(String(hash), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  const authDateMs = Number(fields.auth_date) * 1000;
  if (!authDateMs || Date.now() - authDateMs > AUTH_DATE_MAX_AGE_MS) return false;

  return true;
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Простой парсер заголовка Cookie — без внешней зависимости (cookie-parser).
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  });
  return out;
}

function currentUser(req) {
  const cookies = parseCookies(req.headers.cookie);
  const payload = verifySessionToken(cookies[SESSION_COOKIE]);
  if (!payload || !payload.tid) return null;
  return userStore.getByTelegramId(payload.tid);
}

function setSessionCookie(res, user) {
  const exp = Date.now() + SESSION_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const token = signSession({ uid: user.id, tid: user.telegramId, exp });
  const maxAge = SESSION_MAX_AGE_DAYS * 24 * 60 * 60;
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
}

function publicUser(u) {
  if (!u) return null;
  return { firstName: u.firstName, lastName: u.lastName, username: u.username, photoUrl: u.photoUrl };
}

module.exports = {
  BOT_TOKEN,
  verifyTelegramAuth,
  currentUser,
  setSessionCookie,
  clearSessionCookie,
  publicUser,
};
