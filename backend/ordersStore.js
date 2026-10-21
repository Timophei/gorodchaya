// Заказы — тот же паттерн, что store.js/userStore.js: JSON-файл, атомарная
// перезапись через tmp+rename. Отдельный файл, чтобы не мешать со схемой
// чаёв/пользователей.
const fs = require('fs');
const path = require('path');

const ORDERS_PATH = process.env.ORDERS_STORE_PATH || path.join(__dirname, 'data', 'orders.json');

function load() {
  try {
    const raw = fs.readFileSync(ORDERS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.orders) {
      return { orders: parsed.orders, nextNumber: parsed.nextNumber || 1 };
    }
  } catch {
    // файла ещё нет, либо битый — начинаем с пустого
  }
  return { orders: {}, nextNumber: 1 };
}

const state = load();

function persist() {
  fs.mkdirSync(path.dirname(ORDERS_PATH), { recursive: true });
  const tmp = `${ORDERS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, ORDERS_PATH); // rename атомарен на той же файловой системе
}

// data — уже провалидированное тело заказа (см. OrderSchema в server.js)
// плюс userId (id вошедшего пользователя или null для гостя).
function create(data) {
  const number = state.nextNumber++;
  const id = `ord_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const order = {
    id,
    number,
    status: 'new',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...data,
  };
  state.orders[id] = order;
  persist();
  return order;
}

function getAll() {
  return Object.values(state.orders).sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
}

function getById(id) {
  return state.orders[id] || null;
}

function getByUserId(userId) {
  if (!userId) return [];
  return getAll().filter((o) => o.userId === userId);
}

function updateStatus(id, status) {
  const existing = state.orders[id];
  if (!existing) return null;
  existing.status = status;
  existing.updatedAt = new Date().toISOString();
  persist();
  return existing;
}

// Произвольные служебные поля заказа (списание остатков и т. п.).
function patch(id, fields) {
  const existing = state.orders[id];
  if (!existing) return null;
  Object.assign(existing, fields, { updatedAt: new Date().toISOString() });
  persist();
  return existing;
}

module.exports = { create, getAll, getById, getByUserId, updateStatus, patch, ORDERS_PATH };
