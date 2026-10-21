// Хранилище пользователей — тот же паттерн, что и store.js (JSON-файл,
// атомарная перезапись через tmp+rename). Отдельный файл, чтобы не мешать
// со схемой чаёв.
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

function getAll() {
  return Object.values(state.users);
}

module.exports = { getByTelegramId, upsertTelegramUser, getAll, USERS_PATH };
