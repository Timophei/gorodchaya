// Plain JSON-file-backed store — no native modules.
//
// Switched away from better-sqlite3 after it reliably segfaulted (SIGSEGV)
// on the target VPS the moment it tried to actually open/write a database
// file — reproduced even after a from-source rebuild, as root and as
// www-data, so it wasn't a permissions issue, it was the compiled SQLite
// binary itself misbehaving on that machine's virtualized environment.
// For a catalog of a few dozen teas, a JSON file loaded into memory and
// rewritten atomically on every write is simpler, has zero native
// dependencies to break, and behaves identically on every host.
const fs = require('fs');
const path = require('path');

const STORE_PATH = process.env.STORE_PATH || path.join(__dirname, 'data', 'store.json');

function load() {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.teas) {
      if (!Array.isArray(parsed.removed)) parsed.removed = [];
      if (!parsed.categories || typeof parsed.categories !== 'object') parsed.categories = {};
      return parsed;
    }
  } catch {
    // no file yet, or corrupt — start fresh
  }
  return { teas: {}, removed: [], categories: {} };
}

const state = load();

function persist() {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STORE_PATH); // rename is atomic on the same filesystem
}

function getAll() {
  return Object.values(state.teas);
}

function getById(id) {
  return state.teas[id];
}

function upsert(id, patch) {
  const existing = state.teas[id];
  const merged = {
    ...existing,
    ...patch,
    id,
    prices: patch.prices !== undefined ? patch.prices : (existing ? existing.prices : []),
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  state.teas[id] = merged;
  state.removed = state.removed.filter((x) => x !== id);
  persist();
  return merged;
}

function remove(id) {
  const existed = Object.prototype.hasOwnProperty.call(state.teas, id);
  if (existed) {
    delete state.teas[id];
    // Запоминаем удалённое, чтобы seed.js при переустановке не вернул его.
    if (!state.removed.includes(id)) state.removed.push(id);
    persist();
  }
  return existed;
}

function isRemoved(id) {
  return state.removed.includes(id);
}

function getBySlug(slug) {
  return getAll().find((t) => t.slug === slug) || null;
}

function getByOldSlug(slug) {
  return getAll().find((t) => Array.isArray(t.oldSlugs) && t.oldSlugs.includes(slug)) || null;
}

function getByExternalId(num) {
  return getAll().find((t) => String(t.externalId) === String(num)) || null;
}

// --- категории ---
// Категория — раздел витрины («Зелёный чай», «Коллекция НГ 2027»): название,
// описание, картинка, SEO, активность. Чай может входить в несколько:
// tea.categories — все его категории, tea.category — основная (по ней
// подпись на карточке и «похожие чаи»), она всегда есть и в categories.
function getCategories() {
  return Object.values(state.categories)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.name || '').localeCompare(b.name || '', 'ru'));
}

function getCategory(id) {
  return state.categories[id] || null;
}

function upsertCategory(id, patch) {
  const existing = state.categories[id];
  state.categories[id] = {
    ...existing, ...patch, id,
    createdAt: existing ? existing.createdAt : new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  persist();
  return state.categories[id];
}

function removeCategory(id) {
  if (!state.categories[id]) return false;
  delete state.categories[id];
  persist();
  return true;
}

function teaCategories(t) {
  const list = Array.isArray(t.categories) ? t.categories.slice() : [];
  if (t.category && !list.includes(t.category)) list.unshift(t.category);
  return list;
}

// Несколько изменений чаёв одной записью на диск (миграция, удаление категории).
function patchTeasBulk(fn) {
  let n = 0;
  for (const t of Object.values(state.teas)) {
    const patch = fn(t);
    if (patch) { Object.assign(t, patch, { updatedAt: new Date().toISOString() }); n += 1; }
  }
  if (n) persist();
  return n;
}

module.exports = {
  getAll, getById, getBySlug, getByOldSlug, getByExternalId, upsert, remove, isRemoved, STORE_PATH,
  getCategories, getCategory, upsertCategory, removeCategory, teaCategories, patchTeasBulk,
};
