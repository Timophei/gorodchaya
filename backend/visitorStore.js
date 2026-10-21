// Посетители витрины — тот же паттерн, что store.js/userStore.js (JSON-файл,
// атомарная перезапись). Посетитель — это метка браузера (cookie cg_vid,
// ставит assets/common.js). К ней копятся: просмотры страниц чаёв, id
// диалогов с мастером (cookie tea_cid) и, после входа через Telegram, userId —
// по нему админка склеивает гостя с аккаунтом.
const fs = require('fs');
const path = require('path');

const VISITORS_PATH = process.env.VISITORS_STORE_PATH || path.join(__dirname, 'data', 'visitors.json');
const MAX_VIEWS = 200;        // на одного посетителя, старые вытесняются
const MAX_CIDS = 20;
const MAX_VISITORS = 20000;   // при переполнении уходят самые давние «пустые» гости
const SAME_VIEW_GAP_MS = 30 * 60 * 1000; // повторное открытие того же чая подряд не дублируем

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(VISITORS_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.visitors) return parsed;
  } catch {
    // файла ещё нет, либо битый — начинаем с пустого
  }
  return { visitors: {} };
}

const state = load();

function persist() {
  fs.mkdirSync(path.dirname(VISITORS_PATH), { recursive: true });
  const tmp = `${VISITORS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, VISITORS_PATH);
}

function isValidId(vid) {
  return typeof vid === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(vid);
}

function isEmpty(v) {
  return !v.userId && !v.views.length && !v.cids.length;
}

function prune() {
  const ids = Object.keys(state.visitors);
  if (ids.length <= MAX_VISITORS) return;
  ids
    .filter((id) => isEmpty(state.visitors[id]))
    .sort((a, b) => (state.visitors[a].lastSeen < state.visitors[b].lastSeen ? -1 : 1))
    .slice(0, ids.length - MAX_VISITORS)
    .forEach((id) => { delete state.visitors[id]; });
}

// info: { userId?, cid?, teaId? } — всё необязательно; без них просто
// обновляется lastSeen.
function touch(vid, info = {}) {
  if (!isValidId(vid)) return null;
  const now = new Date().toISOString();
  let v = state.visitors[vid];
  if (!v) {
    v = { id: vid, firstSeen: now, lastSeen: now, userId: null, cids: [], views: [] };
    state.visitors[vid] = v;
    prune();
  }
  v.lastSeen = now;
  if (info.userId) v.userId = info.userId;
  if (info.cid && typeof info.cid === 'string' && info.cid.length <= 100 && !v.cids.includes(info.cid)) {
    v.cids.push(info.cid);
    if (v.cids.length > MAX_CIDS) v.cids.shift();
  }
  if (info.teaId) {
    const last = v.views[v.views.length - 1];
    const dup = last && last.teaId === info.teaId && (Date.now() - Date.parse(last.at)) < SAME_VIEW_GAP_MS;
    if (!dup) {
      v.views.push({ teaId: info.teaId, at: now });
      if (v.views.length > MAX_VIEWS) v.views.splice(0, v.views.length - MAX_VIEWS);
    }
  }
  persist();
  return v;
}

function getAll() {
  return Object.values(state.visitors);
}

function getById(vid) {
  return state.visitors[vid] || null;
}

module.exports = { touch, getAll, getById, isValidId, VISITORS_PATH };
