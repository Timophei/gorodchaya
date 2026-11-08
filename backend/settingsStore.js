// Настройки магазина (админка → «Настройки»): самовывоз, доставка, бот
// уведомлений о заказах, ключ подсказок адреса. Тот же паттерн, что у
// остальных хранилищ: JSON-файл, атомарная перезапись через tmp+rename.
// Секреты (токен бота, ключ DaData) лежат здесь же, но наружу отдаются
// только через publicSettings() — без них.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SETTINGS_PATH = process.env.SETTINGS_STORE_PATH || path.join(DATA_DIR, 'settings.json');

function defaults() {
  return {
    pickup: { enabled: true, address: 'Чудотворная, 2в', city: 'Иркутск', hours: '' },
    delivery: {
      city: { enabled: true, name: 'Иркутск', price: 100, freeFrom: 3000, note: 'привезём в течение дня' },
      russia: { enabled: true, note: 'по тарифам и срокам транспортной компании — стоимость сообщим после оформления' },
    },
    notify: { botToken: '', botUsername: '', subscribeCode: crypto.randomBytes(6).toString('hex'), subscribers: [] },
    dadata: { token: '' },
  };
}

// Глубокое слияние: в сохранённом файле может не быть новых полей — берём их из умолчаний.
function merge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])
      ? merge(base[k], over[k]) : over[k];
  }
  return out;
}

function load() {
  try {
    return merge(defaults(), JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')));
  } catch {
    return defaults();
  }
}

let state = load();

function persist() {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, SETTINGS_PATH);
}

function get() {
  return state;
}

// patch — частичный объект в той же форме, что и state.
function update(patch) {
  state = merge(state, patch);
  persist();
  return state;
}

// Для витрины (корзина): без токенов и подписчиков.
function publicSettings() {
  const s = state;
  return {
    pickup: s.pickup,
    delivery: s.delivery,
    addressSuggest: !!s.dadata.token,
  };
}

// Для админки: токены не отдаём, только признак «задан».
function adminSettings() {
  const s = state;
  return {
    pickup: s.pickup,
    delivery: s.delivery,
    notify: {
      botTokenSet: !!s.notify.botToken,
      botUsername: s.notify.botUsername,
      subscribeCode: s.notify.subscribeCode,
      subscribers: s.notify.subscribers,
    },
    dadata: { tokenSet: !!s.dadata.token },
  };
}

// Стоимость доставки по корзине — одна формула для корзины и сервера.
// Возвращает { price, priceKnown }: по России цена неизвестна до расчёта ТК.
function deliveryQuote(method, subtotal) {
  const d = state.delivery;
  if (method === 'pickup') return { price: 0, priceKnown: true };
  if (method === 'city') {
    const free = Number.isFinite(d.city.freeFrom) && d.city.freeFrom > 0 && subtotal >= d.city.freeFrom;
    return { price: free ? 0 : (d.city.price || 0), priceKnown: true };
  }
  return { price: 0, priceKnown: false };
}

module.exports = { get, update, publicSettings, adminSettings, deliveryQuote, SETTINGS_PATH };
