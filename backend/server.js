const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const store = require('./store');
const auth = require('./auth');
const userStore = require('./userStore');
const ordersStore = require('./ordersStore');
const visitorStore = require('./visitorStore');

// Cookie посетителя: cg_vid — метка браузера (ставит assets/common.js),
// tea_cid — id диалога с мастером (ставит чат на главной).
function readCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  });
  return out;
}

function visitorIdOf(req) {
  const vid = readCookies(req).cg_vid;
  return visitorStore.isValidId(vid) ? vid : null;
}

const CATEGORIES = ['green', 'black', 'oolong', 'puer', 'white', 'yellow', 'herbal'];
const REGIONS = ['china', 'japan', 'india', 'russia', 'thailand'];

// Write endpoints (POST/DELETE) require this key in an `x-api-key` header.
// Only the import script / a future trusted admin tool should ever hold it.
// Generated once per process start if not supplied via env, and printed to
// the log so whoever runs the import can grab it from there.
const API_KEY = process.env.API_KEY || crypto.randomBytes(24).toString('hex');
if (!process.env.API_KEY) {
  console.log(`No API_KEY set — generated one for this run: ${API_KEY}`);
  console.log('Set API_KEY in the environment to pin it across restarts.');
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));

// express.json() throws a SyntaxError into the error-handling middleware on
// bad JSON; catch it (and anything else) here so we never leak a stack
// trace / file paths to the client via Express's default HTML error page.
function jsonErrorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'invalid_json' });
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
}

function requireApiKey(req, res, next) {
  if (req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function withMinPrice(tea) {
  if (!tea) return tea;
  const prices = tea.prices || [];
  const minPrice = prices.length ? Math.min(...prices.map((p) => p.price)) : null;
  return { ...tea, minPrice };
}

// Parses a `featured`-style boolean query param strictly. Anything other
// than "1"/"true" or "0"/"false" is treated as "not set" (the original bug
// this fixes: `featured ? 1 : 0` on the raw string meant `?featured=0` was
// truthy and silently behaved exactly like `?featured=1`).
function parseBoolParam(value) {
  if (value === undefined) return undefined;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

const QuerySchema = z.object({
  category: z.string().max(50).optional(),
  region: z.string().max(50).optional(),
  featured: z.string().max(10).optional(),
  q: z.string().max(200).optional(),
});

// GET /api/teas?category=green&region=china&featured=1&q=пуэр
app.get('/api/teas', (req, res) => {
  const parsedQuery = QuerySchema.safeParse(req.query);
  if (!parsedQuery.success) {
    return res.status(400).json({ error: 'invalid_query', details: parsedQuery.error.issues });
  }
  const { category, region, q } = parsedQuery.data;
  const featured = parseBoolParam(parsedQuery.data.featured);
  const qLower = q ? q.toLowerCase() : null;

  let teas = store.getAll();
  if (category) teas = teas.filter((t) => t.category === category);
  if (region) teas = teas.filter((t) => t.region === region);
  if (featured !== undefined) teas = teas.filter((t) => !!t.featured === featured);
  if (qLower) teas = teas.filter((t) => t.name && t.name.toLowerCase().includes(qLower));

  teas = teas.slice().sort((a, b) => {
    const so = (a.sortOrder || 0) - (b.sortOrder || 0);
    if (so !== 0) return so;
    return (a.name || '').localeCompare(b.name || '', 'ru');
  });

  res.json(teas.map(withMinPrice));
});

app.get('/api/teas/:id', (req, res) => {
  const tea = store.getById(req.params.id);
  if (!tea) return res.status(404).json({ error: 'not_found' });
  res.json(withMinPrice(tea));
});

app.get('/api/categories', (_req, res) => {
  const counts = new Map();
  for (const t of store.getAll()) {
    if (!counts.has(t.category)) counts.set(t.category, { id: t.category, label: t.categoryLabel || t.category, count: 0 });
    counts.get(t.category).count += 1;
  }
  res.json([...counts.values()].sort((a, b) => b.count - a.count));
});

app.get('/api/regions', (_req, res) => {
  const counts = new Map();
  for (const t of store.getAll()) {
    if (!t.region) continue;
    if (!counts.has(t.region)) counts.set(t.region, { id: t.region, label: t.regionLabel || t.region, count: 0 });
    counts.get(t.region).count += 1;
  }
  res.json([...counts.values()].sort((a, b) => b.count - a.count));
});

// --- write endpoints, for the import script / any future admin tool ---
// Protected by requireApiKey: only someone holding the process's API_KEY
// (printed to the server log, or set via the API_KEY env var) can write.

const PriceSchema = z.object({
  weightGrams: z.coerce.number().int().positive().max(100000),
  price: z.coerce.number().int().nonnegative().max(10000000),
});

const TeaSchema = z.object({
  id: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'id must be alphanumeric, "-", or "_"'),
  externalId: z.string().max(50).nullable().optional(),
  name: z.string().trim().min(1).max(200),
  subtitle: z.string().max(300).nullable().optional(),
  category: z.enum(CATEGORIES),
  categoryLabel: z.string().max(100).optional(),
  region: z.enum(REGIONS).nullable().optional(),
  regionLabel: z.string().max(200).nullable().optional(),
  description: z.string().max(5000).nullable().optional(),
  shortDescription: z.string().max(500).nullable().optional(),
  taste: z.array(z.string().max(100)).max(30).optional(),
  tasteNote: z.string().max(1000).nullable().optional(),
  situations: z.array(z.string().max(150)).max(30).optional(),
  effectsNote: z.string().max(1000).nullable().optional(),
  liquorColor: z.string().max(200).nullable().optional(),
  waterTemperature: z.string().max(50).nullable().optional(),
  vessels: z.array(z.string().max(150)).max(30).optional(),
  brewing: z.record(z.string(), z.string().max(2000)).optional(),
  contraindications: z.array(z.string().max(300)).max(30).optional(),
  // Авторские заметки бренда/мастера ("Мнение Города") — отдельное поле,
  // а не часть description, чтобы на странице товара это был явно
  // подписанный блок, и чтобы в будущем разные "боты" могли ссылаться
  // на разные мнения, не переписывая основное описание.
  cityOpinion: z.string().max(3000).nullable().optional(),
  imageUrl: z.string().max(1000).nullable().optional(),
  gradient: z.string().max(300).nullable().optional(),
  featured: z.boolean().optional(),
  popular: z.boolean().optional(),
  rating: z.number().min(0).max(5).nullable().optional(),
  reviewCount: z.number().int().nonnegative().max(1000000).optional(),
  stock: z.number().int().nonnegative().max(1000000).optional(),
  sortOrder: z.number().int().optional(),
  prices: z.array(PriceSchema).max(50).optional(),
});

app.post('/api/teas', requireApiKey, (req, res) => {
  const parsed = TeaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.issues });
  }
  const { id, ...patch } = parsed.data;
  // categoryLabel defaults to the raw category if neither the request nor
  // the existing row already has a nicer label.
  if (!patch.categoryLabel) {
    const existing = store.getById(id);
    patch.categoryLabel = existing?.categoryLabel || patch.category;
  }
  const saved = store.upsert(id, patch);
  res.status(201).json(withMinPrice(saved));
});

app.delete('/api/teas/:id', requireApiKey, (req, res) => {
  const existed = store.remove(req.params.id);
  if (!existed) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

// Счётчик нажатий «Купить» (assets/common.js: buyClick). Эндпоинт был добавлен
// прямо на старом сервере и пропал вместе с ним — восстановлен 2026-10-08.
app.post('/api/teas/:id/buy-click', (req, res) => {
  const tea = store.getById(req.params.id);
  if (!tea) return res.status(404).json({ error: 'not_found' });
  const saved = store.upsert(req.params.id, { buyClicks: (tea.buyClicks || 0) + 1 });
  res.json({ id: saved.id, buyClicks: saved.buyClicks });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// --- вход через Telegram Login Widget ---
// Пароля/своей регистрации нет: фронтенд получает данные от Telegram
// (см. account.html) и присылает их сюда как есть — сервер сам проверяет
// подлинность (HMAC от бота) прежде чем кому-то доверять. Сессия — это
// подписанная cookie, без базы сессий на сервере.

const TelegramAuthSchema = z.object({
  id: z.union([z.number(), z.string()]),
  first_name: z.string().max(200).optional(),
  last_name: z.string().max(200).optional(),
  username: z.string().max(200).optional(),
  photo_url: z.string().max(2000).optional(),
  auth_date: z.union([z.number(), z.string()]),
  hash: z.string().min(1),
});

app.post('/api/auth/telegram', (req, res) => {
  if (!auth.BOT_TOKEN) return res.status(503).json({ error: 'telegram_not_configured' });
  const parsed = TelegramAuthSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.issues });
  if (!auth.verifyTelegramAuth(parsed.data)) return res.status(401).json({ error: 'invalid_telegram_auth' });

  const user = userStore.upsertTelegramUser(parsed.data);
  auth.setSessionCookie(res, user);
  // Склеиваем гостя (метку браузера) с аккаунтом — его просмотры и диалоги
  // с этого момента показываются в карточке пользователя.
  const vid = visitorIdOf(req);
  if (vid) visitorStore.touch(vid, { userId: user.id, cid: readCookies(req).tea_cid });
  res.json({ user: auth.publicUser(user) });
});

app.get('/api/auth/me', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ user: auth.publicUser(user) });
});

app.post('/api/auth/logout', (_req, res) => {
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// --- заказы ---
// Корзина живёт в браузере (localStorage) — сюда прилетает уже готовый
// список товаров и данные доставки, когда покупатель жмёт «Оформить заказ»
// на cart.html. Если покупатель вошёл через Telegram, заказ привязывается
// к его userId (нужно для «Моих заказов» на account.html); гостю заказ всё
// равно создаётся, просто без привязки к аккаунту.

const OrderItemSchema = z.object({
  teaId: z.string().max(100),
  name: z.string().trim().min(1).max(200),
  weightGrams: z.coerce.number().int().positive().max(100000).nullable().optional(),
  qty: z.coerce.number().int().positive().max(100),
  unitPrice: z.coerce.number().int().nonnegative().max(10000000),
});

const OrderCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  phone: z.string().trim().min(5).max(40),
  address: z.string().trim().min(5).max(500),
  comment: z.string().trim().max(1000).optional(),
});

const OrderSchema = z.object({
  items: z.array(OrderItemSchema).min(1).max(50),
  subtotal: z.coerce.number().int().nonnegative(),
  deliveryPrice: z.coerce.number().int().nonnegative(),
  discount: z.coerce.number().int().nonnegative().optional(),
  promoCode: z.string().max(50).nullable().optional(),
  total: z.coerce.number().int().nonnegative(),
  customer: OrderCustomerSchema,
});

app.post('/api/orders', (req, res) => {
  const parsed = OrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.issues });
  }
  const user = auth.currentUser(req);
  const visitorId = visitorIdOf(req);
  if (visitorId) visitorStore.touch(visitorId, { userId: user ? user.id : null, cid: readCookies(req).tea_cid });
  const order = ordersStore.create({ ...parsed.data, userId: user ? user.id : null, visitorId });
  res.status(201).json({ order });
});

app.get('/api/orders/mine', (req, res) => {
  const user = auth.currentUser(req);
  if (!user) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ orders: ordersStore.getByUserId(user.id) });
});

// Для внутренней админки (см. tea-consultant/public/admin/index.php) — тот
// же x-api-key, что и у /api/teas на запись; страница ходит сюда напрямую
// по localhost, без выхода наружу.
app.get('/api/orders', requireApiKey, (_req, res) => {
  res.json({ orders: ordersStore.getAll() });
});

const OrderStatusSchema = z.object({
  status: z.enum(['new', 'processing', 'done', 'cancelled']),
});

app.post('/api/orders/:id/status', requireApiKey, (req, res) => {
  const parsed = OrderStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation_failed', details: parsed.error.issues });
  const updated = ordersStore.updateStatus(req.params.id, parsed.data.status);
  if (!updated) return res.status(404).json({ error: 'not_found' });
  res.json({ order: updated });
});

// --- посетители: метка браузера, история просмотров ---
// Витрина дёргает это на каждой загрузке страницы (assets/common.js: track).
// На страницах чая приходит teaId — он и попадает в «что смотрел».
const TrackSchema = z.object({ teaId: z.string().max(100).nullable().optional() });

app.post('/api/track', (req, res) => {
  const vid = visitorIdOf(req);
  const parsed = TrackSchema.safeParse(req.body || {});
  if (!vid || !parsed.success) return res.status(204).end();
  const teaId = parsed.data.teaId && store.getById(parsed.data.teaId) ? parsed.data.teaId : null;
  const user = auth.currentUser(req);
  visitorStore.touch(vid, { teaId, cid: readCookies(req).tea_cid, userId: user ? user.id : null });
  res.status(204).end();
});

// --- админка: пользователи (см. tea-consultant/public/admin/index.php, вкладка «Пользователи») ---
// «Человек» — это либо аккаунт Telegram со всеми его браузерами, либо гость
// (одна метка браузера). Ключи: u_<telegramId> и v_<visitorId>.
function buildPeople() {
  const people = new Map();
  const byVisitor = new Map(); // visitorId -> ключ человека

  for (const u of userStore.getAll()) {
    people.set(`u_${u.telegramId}`, {
      key: `u_${u.telegramId}`, kind: 'user', userId: u.id,
      name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username || `Telegram ${u.telegramId}`,
      username: u.username || null, telegramId: u.telegramId, photoUrl: u.photoUrl || null,
      firstSeen: u.createdAt, lastSeen: u.lastLoginAt,
      visitorIds: [], cids: [], views: [], orders: [],
    });
  }
  const userKeyById = new Map([...people.values()].map((p) => [p.userId, p.key]));

  for (const v of visitorStore.getAll()) {
    let key = v.userId ? userKeyById.get(v.userId) : null;
    if (!key) {
      key = `v_${v.id}`;
      people.set(key, {
        key, kind: 'guest', userId: null, name: `Гость ${v.id.slice(0, 6)}`,
        username: null, telegramId: null, photoUrl: null,
        firstSeen: v.firstSeen, lastSeen: v.lastSeen,
        visitorIds: [], cids: [], views: [], orders: [],
      });
    }
    const p = people.get(key);
    p.visitorIds.push(v.id);
    v.cids.forEach((c) => { if (!p.cids.includes(c)) p.cids.push(c); });
    p.views.push(...v.views);
    if (v.firstSeen < p.firstSeen) p.firstSeen = v.firstSeen;
    if (v.lastSeen > p.lastSeen) p.lastSeen = v.lastSeen;
    byVisitor.set(v.id, key);
  }

  for (const o of ordersStore.getAll()) {
    const key = (o.userId && userKeyById.get(o.userId)) || (o.visitorId && byVisitor.get(o.visitorId));
    if (key) people.get(key).orders.push(o);
  }

  for (const p of people.values()) {
    p.views.sort((a, b) => (a.at < b.at ? 1 : -1));
    // Гостю из заказа известны имя и телефон — показываем их вместо «Гость abc123».
    const withContact = p.orders.find((o) => o.customer && o.customer.name);
    p.contact = withContact ? { name: withContact.customer.name, phone: withContact.customer.phone || null } : null;
  }
  return { people, byVisitor };
}

function personSummary(p) {
  return {
    key: p.key, kind: p.kind, name: p.name, username: p.username, telegramId: p.telegramId,
    photoUrl: p.photoUrl, contact: p.contact, firstSeen: p.firstSeen, lastSeen: p.lastSeen,
    ordersCount: p.orders.length, viewsCount: p.views.length, chatsCount: p.cids.length,
    ordersTotal: p.orders.reduce((s, o) => s + (o.status === 'cancelled' ? 0 : (o.total || 0)), 0),
  };
}

app.get('/api/admin/people', requireApiKey, (_req, res) => {
  const { people } = buildPeople();
  const list = [...people.values()]
    // Гость, который ничего не открыл, не писал мастеру и не заказывал, — шум.
    .filter((p) => p.kind === 'user' || p.views.length || p.cids.length || p.orders.length)
    .map(personSummary)
    .sort((a, b) => (a.lastSeen < b.lastSeen ? 1 : -1));
  res.json({ people: list });
});

app.get('/api/admin/people/:key', requireApiKey, (req, res) => {
  const { people, byVisitor } = buildPeople();
  let key = req.params.key;
  // Ссылка по метке браузера, которая уже склеена с аккаунтом, ведёт на аккаунт.
  if (key.startsWith('v_') && byVisitor.has(key.slice(2))) key = byVisitor.get(key.slice(2));
  const p = people.get(key);
  if (!p) return res.status(404).json({ error: 'not_found' });
  const views = p.views.map((v) => {
    const tea = store.getById(v.teaId);
    return { teaId: v.teaId, name: tea ? tea.name : v.teaId, at: v.at };
  });
  res.json({ person: personSummary(p), cids: p.cids, orders: p.orders, views });
});

app.use(jsonErrorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, '127.0.0.1', () => console.log(`Чайный город API listening on :${PORT}`));
