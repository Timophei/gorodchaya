// Хранилище пользователей — тот же паттерн, что и store.js (JSON-файл,
// атомарная перезапись через tmp+rename). Отдельный файл, чтобы не мешать
// со схемой чаёв.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const USERS_PATH = process.env.USERS_STORE_PATH || path.join(__dirname, 'data', 'users.json');

function load() {
  try {
    const raw = fs.readFileSync(USERS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.users) return parsed;
  } catch {
    // файла ещё нет, либо битый — начинаем с пустого
  }
  return { users: {} };
}

const state = load();

function persist() {
  fs.mkdirSync(path.dirname(USERS_PATH), { recursive: true });
  const tmp = `${USERS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, USERS_PATH);
}

function keyForTelegramId(telegramId) {
  return `tg:${telegramId}`;
}

function getByTelegramId(telegramId) {
  return state.users[keyForTelegramId(telegramId)] || null;
}

// tgUser — сырые данные из Telegram Login Widget: { id, first_name,
// last_name?, username?, photo_url?, auth_date }. Вызывать только ПОСЛЕ
// verifyTelegramAuth() из auth.js — здесь подлинность уже не проверяется.
function upsertTelegramUser(tgUser) {
  const key = keyForTelegramId(tgUser.id);
  const existing = state.users[key];
  const merged = {
    id: key,
    provider: 'telegram',
    telegramId: tgUser.id,
    firstName: tgUser.first_name || '',
    lastName: tgUser.last_name || '',
    username: tgUser.username || null,
    photoUrl: tgUser.photo_url || null,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };
  state.users[key] = merged;
  persist();
  return merged;
}

function getById(id) {
  return (id && state.users[id]) || null;
}

// --- аккаунты по почте (пока без подтверждения адреса) ---
function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function getByEmail(email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return Object.values(state.users).find((u) => u.provider === 'email' && u.email === e) || null;
}

// Пароль храним только как scrypt-хеш с солью: "scrypt$<соль>$<хеш>".
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function checkPassword(user, password) {
  if (!user || !user.passwordHash) return false;
  const [kind, salt, hash] = String(user.passwordHash).split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = crypto.scryptSync(String(password), salt, 64);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// null, если такая почта уже зарегистрирована.
function createEmailUser({ email, password, name }) {
  const e = normalizeEmail(email);
  if (getByEmail(e)) return null;
  const id = `em:${crypto.randomBytes(8).toString('hex')}`;
  const now = new Date().toISOString();
  const user = {
    id,
    provider: 'email',
    email: e,
    emailVerified: false,
    passwordHash: hashPassword(password),
    firstName: String(name || '').trim(),
    lastName: '',
    username: null,
    photoUrl: null,
    createdAt: now,
    lastLoginAt: now,
  };
  state.users[id] = user;
  persist();
  return user;
}

function touchLogin(user) {
  user.lastLoginAt = new Date().toISOString();
  persist();
  return user;
}

function getAll() {
  return Object.values(state.users);
}

module.exports = {
  getByTelegramId, upsertTelegramUser, getById, getByEmail, createEmailUser, checkPassword, touchLogin,
  normalizeEmail, getAll, USERS_PATH,
};
