const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { z } = require('zod');
const store = require('./store');
const auth = require('./auth');
const userStore = require('./userStore');
const ordersStore = require('./ordersStore');
const visitorStore = require('./visitorStore');
const catalog = require('./catalogSync');

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

// teaware — посуда: продаётся поштучно, у цены weightGrams = 0.
const CATEGORIES = ['green', 'black', 'oolong', 'puer', 'white', 'yellow', 'herbal', 'teaware'];
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

const PORT = process.env.PORT || 4000;
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
  // 0 — поштучный товар (посуда).
  weightGrams: z.coerce.number().int().nonnegative().max(100000),
  price: z.coerce.number().int().nonnegative().max(10000000),
  // Остаток этой фасовки в штуках (пачках). null — не ведётся. Может уйти
  // в минус: продаём и то, чего нет («под заказ»).
  stock: z.union([z.null(), z.coerce.number().int().min(-1000000).max(1000000)]).optional(),
});

const TeaSchema = z.object({
  // Без id — новый чай: id и адрес придумываются из названия.
  id: z.string().trim().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'id must be alphanumeric, "-", or "_"').optional(),
  slug: z.string().trim().max(80).regex(catalog.SLUG_RE, 'адрес: только латиница в нижнем регистре, цифры и дефисы').optional().or(z.literal('')),
  seoTitle: z.string().trim().max(120).nullable().optional(),
  seoDescription: z.string().trim().max(300).nullable().optional(),
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
  let { id, ...patch } = parsed.data;
  if (!id) {
    id = catalog.uniqueSlug(catalog.slugify(patch.name), null).replace(/-/g, '').slice(0, 40) || `tea${Date.now()}`;
    while (store.getById(id)) id += 'x';
  }
  const existing = store.getById(id);

  // Номер (короткая ссылка /t/<номер>, связь с Битриксом и мастером) — уникальный.
  if (patch.externalId === undefined || patch.externalId === null || patch.externalId === '') {
    patch.externalId = existing?.externalId || catalog.nextExternalId();
  }
  if (!/^\d{1,9}$/.test(String(patch.externalId))) {
    return res.status(400).json({ error: 'validation_failed', details: [{ path: ['externalId'], message: 'номер — только цифры' }] });
  }
  const numOwner = store.getByExternalId(patch.externalId);
  if (numOwner && numOwner.id !== id) {
    return res.status(409).json({ error: 'external_id_taken', details: [{ path: ['externalId'], message: `номер ${patch.externalId} уже у «${numOwner.name}»` }] });
  }

  // Адрес страницы: пустой — придумываем из названия; занятый — ошибка;
  // сменился — старый запоминаем, чтобы по нему был редирект.
  if (!patch.slug) patch.slug = existing?.slug || catalog.uniqueSlug(catalog.slugify(patch.name), id);
  if (catalog.slugTaken(patch.slug, id)) {
    return res.status(409).json({ error: 'slug_taken', details: [{ path: ['slug'], message: `адрес /tea/${patch.slug} уже занят` }] });
  }
  if (existing?.slug && existing.slug !== patch.slug) {
    patch.oldSlugs = [...new Set([...(existing.oldSlugs || []), existing.slug])].filter((x) => x !== patch.slug);
  }

  // categoryLabel defaults to the raw category if neither the request nor
  // the existing row already has a nicer label.
  if (!patch.categoryLabel) {
    patch.categoryLabel = existing?.categoryLabel || patch.category;
  }
  const saved = store.upsert(id, patch);
  catalog.onCatalogChanged(PORT);
  res.status(201).json(withMinPrice(saved));
});

app.delete('/api/teas/:id', requireApiKey, (req, res) => {
  const existed = store.remove(req.params.id);
  if (!existed) return res.status(404).json({ error: 'not_found' });
  catalog.onCatalogChanged(PORT);
  res.status(204).end();
});

// --- админка, вкладка «Продукты» ---
// Фото: браузер уже ужал картинку, сюда приходят сырые байты.
const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'webp';
  return null;
}

app.post('/api/admin/teas/:id/photo', requireApiKey,
  express.raw({ type: Object.keys(IMAGE_TYPES), limit: '10mb' }),
  (req, res) => {
    const tea = store.getById(req.params.id);
    if (!tea) return res.status(404).json({ error: 'not_found' });
    const ext = Buffer.isBuffer(req.body) ? sniffImage(req.body) : null;
    if (!ext) return res.status(400).json({ error: 'not_an_image' });
    const dir = require('path').join(catalog.SITE_DIR, 'assets', 'teas');
    const name = `${tea.id}-${Date.now().toString(36)}.${ext}`;
    try {
      require('fs').mkdirSync(dir, { recursive: true });
      require('fs').writeFileSync(require('path').join(dir, name), req.body);
    } catch (e) {
      return res.status(500).json({ error: 'write_failed', message: e.message });
    }
    const saved = store.upsert(tea.id, { imageUrl: `assets/teas/${name}` });
    catalog.onCatalogChanged(PORT);
    res.json(withMinPrice(saved));
  });

app.get('/api/admin/catalog-status', requireApiKey, (_req, res) => {
  res.json({ ...catalog.status, origin: catalog.SITE_ORIGIN });
});

app.post('/api/admin/catalog-sync', requireApiKey, (_req, res) => {
  catalog.syncNow(PORT);
  res.status(202).json({ ok: true });
});

// --- короткие и старые ссылки (nginx отдаёт сюда /t/<номер>, tea-<id>.html и
// неизвестные /tea/<адрес>) ---
function teaPath(t) { return `/tea/${t.slug}`; }

function notFoundPage(res) {
  res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>Чай не найден — Чайный город</title>' +
    '<body style="font-family:sans-serif;text-align:center;padding:60px 20px;background:#F4EFE2;color:#22392B">' +
    '<h1 style="font-size:22px">Такого чая у нас нет</h1><p><a href="/catalog.html" style="color:#22392B">Перейти в каталог</a></p></body>');
}

app.get('/go/t/:num', (req, res) => {
  const t = store.getByExternalId(req.params.num);
  return t && t.slug ? res.redirect(301, teaPath(t)) : notFoundPage(res);
});

app.get('/go/id/:id', (req, res) => {
  const t = store.getById(req.params.id);
  return t && t.slug ? res.redirect(301, teaPath(t)) : notFoundPage(res);
});

app.get('/go/slug/:slug', (req, res) => {
  const t = store.getByOldSlug(req.params.slug);
  return t && t.slug ? res.redirect(301, teaPath(t)) : notFoundPage(res);
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
  weightGrams: z.coerce.number().int().nonnegative().max(100000).nullable().optional(),
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

// Фасовка позиции заказа: по граммам, а у поштучного/однофасовочного товара — единственная.
function priceEntryFor(tea, weightGrams) {
  const prices = tea && Array.isArray(tea.prices) ? tea.prices : [];
  return prices.find((p) => p.weightGrams === (weightGrams || 0))
    || (!weightGrams && prices.length === 1 ? prices[0] : null);
}

// Сколько из позиции есть на складе прямо сейчас, а сколько — «под заказ».
// Купить можно всегда; эта пометка нужна покупателю и тому, кто собирает заказ.
function markAvailability(items) {
  return items.map((it) => {
    const entry = priceEntryFor(store.getById(it.teaId), it.weightGrams);
    const stock = entry && Number.isFinite(entry.stock) ? Math.max(0, entry.stock) : 0;
    const preorderQty = Math.max(0, it.qty - stock);
    return { ...it, stockAtOrder: stock, preorderQty };
  });
}

app.post('/api/orders', (req, res) => {
  const parsed = OrderSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.issues });
  }
  const user = auth.currentUser(req);
  const visitorId = visitorIdOf(req);
  if (visitorId) visitorStore.touch(visitorId, { userId: user ? user.id : null, cid: readCookies(req).tea_cid });
  const items = markAvailability(parsed.data.items);
  const order = ordersStore.create({
    ...parsed.data, items, source: 'site', hasPreorder: items.some((it) => it.preorderQty > 0),
    userId: user ? user.id : null, visitorId,
  });
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
  status: z.enum(['new', 'processing', 'shipped', 'done', 'cancelled']),
});

// --- остатки ---
// Заказ уходит в «Отправлен» — остаток каждой позиции списывается (один раз).
// Откатили в «Новый» / «В работе» / «Отменён» — списанное возвращается.
// «Выполнен» после «Отправлен» ничего не меняет.
// Позже здесь же будет создаваться списание/перемещение в Битрикс24.
function moveStock(order, direction) {
  const moves = [];
  const unmatched = [];
  const changed = new Map(); // teaId -> prices
  for (const it of order.items || []) {
    const tea = store.getById(it.teaId);
    const prices = changed.get(it.teaId) || (tea && Array.isArray(tea.prices) ? tea.prices.map((p) => ({ ...p })) : null);
    if (!tea || !prices || !prices.length) { unmatched.push(it.name || it.teaId); continue; }
    const entry = priceEntryFor({ prices }, it.weightGrams);
    if (!entry) { unmatched.push(`${it.name}${it.weightGrams ? `, ${it.weightGrams} г` : ''}`); continue; }
    const before = Number.isFinite(entry.stock) ? entry.stock : 0;
    entry.stock = before + direction * (it.qty || 1);
    changed.set(it.teaId, prices);
    moves.push({ teaId: it.teaId, name: it.name, weightGrams: entry.weightGrams, qty: direction * (it.qty || 1), before, after: entry.stock });
  }
  for (const [teaId, prices] of changed) store.upsert(teaId, { prices });
  return { moves, unmatched };
}

app.post('/api/orders/:id/status', requireApiKey, (req, res) => {
  const parsed = OrderStatusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation_failed', details: parsed.error.issues });
  const order = ordersStore.getById(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  const next = parsed.data.status;
  const at = new Date().toISOString();
  let stock = null;
  if (next === 'shipped' && !order.stockWrittenOff) {
    stock = moveStock(order, -1);
    ordersStore.patch(order.id, {
      stockWrittenOff: true,
      stockLog: [...(order.stockLog || []), { at, action: 'writeoff', ...stock }],
    });
  } else if (order.stockWrittenOff && ['new', 'processing', 'cancelled'].includes(next)) {
    stock = moveStock(order, +1);
    ordersStore.patch(order.id, {
      stockWrittenOff: false,
      stockLog: [...(order.stockLog || []), { at, action: 'return', ...stock }],
    });
  }
  const updated = ordersStore.updateStatus(order.id, next);
  if (stock && stock.moves.length) catalog.onCatalogChanged(PORT);
  res.json({ order: updated, stock });
});

// --- продажа в магазине (офлайн) ---
// Админка, вкладка «Заказы» → «Продажа в магазине». Названия и цены берутся
// из каталога (цену можно переопределить — скидка на месте), заказ сразу
// «Выполнен», остаток списывается тут же. Отмена вернёт остаток, как обычно.
const OfflineSaleSchema = z.object({
  items: z.array(z.object({
    teaId: z.string().max(100),
    weightGrams: z.coerce.number().int().nonnegative().max(100000).nullable().optional(),
    qty: z.coerce.number().int().positive().max(1000),
    unitPrice: z.coerce.number().int().nonnegative().max(10000000).nullable().optional(),
  })).min(1).max(50),
  customer: z.object({
    name: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(40).optional(),
    comment: z.string().trim().max(1000).optional(),
  }).optional(),
  payment: z.enum(['cash', 'card', 'transfer']).optional(),
  seller: z.string().trim().max(100).optional(),
  test: z.boolean().optional(),
});

app.post('/api/admin/orders/offline', requireApiKey, (req, res) => {
  const parsed = OfflineSaleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'validation_failed', details: parsed.error.issues });
  const bad = [];
  const raw = parsed.data.items.map((it) => {
    const tea = store.getById(it.teaId);
    const entry = priceEntryFor(tea, it.weightGrams);
    if (!tea || !entry) { bad.push(it.teaId); return null; }
    return {
      teaId: tea.id, name: tea.name, weightGrams: entry.weightGrams || null, qty: it.qty,
      unitPrice: it.unitPrice != null ? it.unitPrice : entry.price,
    };
  });
  if (bad.length) return res.status(400).json({ error: 'unknown_items', details: bad });
  const items = markAvailability(raw);
  const subtotal = items.reduce((s, it) => s + it.unitPrice * it.qty, 0);
  const c = parsed.data.customer || {};
  const order = ordersStore.create({
    items, subtotal, deliveryPrice: 0, discount: 0, promoCode: null, total: subtotal,
    customer: { name: c.name || 'Покупатель в магазине', phone: c.phone || '', address: 'Самовывоз — продажа в магазине', comment: c.comment || undefined },
    source: 'offline', payment: parsed.data.payment || null, seller: parsed.data.seller || null,
    test: !!parsed.data.test, hasPreorder: items.some((it) => it.preorderQty > 0),
    userId: null, visitorId: null,
  });
  const stock = moveStock(order, -1);
  ordersStore.patch(order.id, {
    stockWrittenOff: true,
    stockLog: [{ at: new Date().toISOString(), action: 'writeoff', ...stock }],
  });
  const done = ordersStore.updateStatus(order.id, 'done');
  if (stock.moves.length) catalog.onCatalogChanged(PORT);
  res.status(201).json({ order: done, stock });
});

// Удаление заказа (тестового или ошибочного). Списанный остаток возвращается.
app.delete('/api/orders/:id', requireApiKey, (req, res) => {
  const order = ordersStore.getById(req.params.id);
  if (!order) return res.status(404).json({ error: 'not_found' });
  let stock = null;
  if (order.stockWrittenOff) {
    stock = moveStock(order, +1);
    if (stock.moves.length) catalog.onCatalogChanged(PORT);
  }
  ordersStore.remove(order.id);
  res.json({ removed: order.id, stock });
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

  // Заказы с сайта — к аккаунту или браузеру; по ним же запоминаем телефоны.
  const phoneKey = new Map(); // цифры телефона -> ключ человека
  const digits = (ph) => String(ph || '').replace(/\D/g, '').replace(/^8(?=\d{10}$)/, '7');
  const offline = [];
  for (const o of ordersStore.getAll()) {
    const key = (o.userId && userKeyById.get(o.userId)) || (o.visitorId && byVisitor.get(o.visitorId));
    if (!key) { offline.push(o); continue; }
    people.get(key).orders.push(o);
    const d = digits(o.customer && o.customer.phone);
    if (d.length >= 10 && !phoneKey.has(d)) phoneKey.set(d, key);
  }
  // Продажи в магазине — по телефону: к тому, кто уже заказывал с этим
  // телефоном на сайте, или отдельной карточкой «Покупатель магазина».
  for (const o of offline) {
    const d = digits(o.customer && o.customer.phone);
    if (d.length < 10) continue; // без телефона — в базу покупателей не попадает
    let key = phoneKey.get(d);
    if (!key) {
      key = `p_${d}`;
      phoneKey.set(d, key);
      people.set(key, {
        key, kind: o.source === 'offline' ? 'shop' : 'guest', userId: null, name: (o.customer && o.customer.name) || `+${d}`,
        username: null, telegramId: null, photoUrl: null,
        firstSeen: o.createdAt, lastSeen: o.createdAt,
        visitorIds: [], cids: [], views: [], orders: [],
      });
    }
    const p = people.get(key);
    p.orders.push(o);
    if (o.createdAt < p.firstSeen) p.firstSeen = o.createdAt;
    if (o.createdAt > p.lastSeen) p.lastSeen = o.createdAt;
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

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Чайный город API listening on :${PORT}`);
  catalog.ensureSlugsAndNumbers();
  catalog.onCatalogChanged(PORT); // страницы и база мастера — по актуальному каталогу
});
