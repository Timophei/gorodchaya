// Настройка блоков сайта (админка → «Блоки»): шапка, главный чат, первая
// витрина, Чайная гильдия, подвал. Сохранение сразу на живой сайт; каждая
// правка кладёт прежнее состояние в историю, к любой версии можно откатиться.
// Умолчания повторяют то, что было зашито в вёрстку до появления настроек,
// так что после обновления сайт выглядит как раньше.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BLOCKS_PATH = process.env.BLOCKS_STORE_PATH || path.join(DATA_DIR, 'site-blocks.json');
const HISTORY_MAX = 30;

const BLOCK_NAMES = { header: 'Шапка', chat: 'Главный чат', productChat: 'Чат в карточке товара', showcase: 'Первая витрина', guild: 'Чайная гильдия', footer: 'Подвал' };

function defaults() {
  return {
    header: {
      logoUrl: null, // null — фирменный логотип assets/logo-full.png
      quote: 'Хороший чай\nсобирает хороших людей',
      showQuote: true,
      menu: [
        { key: 'chat', label: 'Чат', href: 'index.html', enabled: true },
        { key: 'catalog', label: 'Каталог', href: 'catalog.html', enabled: true },
        { key: 'teaware', label: 'Посуда', href: 'catalog.html?type=teaware', enabled: true },
        { key: 'guild', label: 'Гильдия', href: 'guild.html', enabled: true },
        { key: 'about', label: 'О городе', href: 'about.html', enabled: true },
      ],
    },
    chat: {
      enabled: true,
      greeting: 'Привет, какой чай тебя интересует?',
      chips: [
        { label: 'Подобрать чай', text: '' },
        { label: 'Как заваривать?', text: '' },
        { label: 'Для спокойствия', text: '' },
        { label: 'В дорогу', text: '' },
      ],
      catalogButton: true,
      catalogButtonLabel: 'Сразу в каталог',
    },
    // Чат с мастером справа от цены на странице чая. {чай} — название чая.
    productChat: {
      enabled: true,
      title: 'Спросите мастера',
      greeting: 'Расскажу про «{чай}»: как заварить, с чем пить и на что он похож. Спрашивайте!',
      chips: [
        { label: 'Как заварить?', text: '' },
        { label: 'Чем он особенный?', text: '' },
        { label: 'Что взять к нему?', text: '' },
      ],
    },
    showcase: {
      enabled: true,
      title: 'Популярные чаи',
      description: 'Проверенные вкусы для любого настроения.',
      source: 'featured', // featured — отмеченные «Популярные» в карточке чая; category; manual
      categoryId: null,
      teaIds: [],
      limit: 4,
      showAllCard: true,
    },
    guild: { enabled: true },
    footer: {
      enabled: true,
      nav: [
        { key: 'chat', title: 'Чат с мастером', sub: 'Задайте вопрос', href: 'index.html', enabled: true },
        { key: 'catalog', title: 'Каталог', sub: 'Тысячи чаёв', href: 'catalog.html', enabled: true },
        { key: 'guild', title: 'Гильдия', sub: 'Люди и традиции', href: 'guild.html', enabled: true },
        { key: 'about', title: 'О городе', sub: 'Наш путь и ценности', href: 'about.html', enabled: true },
      ],
      contacts: { address: '', phone: '', email: '', hours: '', mapUrl: '' },
      socials: { telegram: '', vk: '', whatsapp: '' },
      requisites: '',
      copyright: '',
    },
  };
}

// Слияние с умолчаниями: новые поля из будущих версий подтягиваются сами.
function merge(base, over) {
  if (Array.isArray(base)) return Array.isArray(over) ? over : base;
  if (!base || typeof base !== 'object') return over === undefined ? base : over;
  const out = { ...base };
  if (over && typeof over === 'object') for (const k of Object.keys(over)) out[k] = k in base ? merge(base[k], over[k]) : over[k];
  return out;
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(BLOCKS_PATH, 'utf8'));
    return { current: merge(defaults(), raw.current || {}), history: Array.isArray(raw.history) ? raw.history : [] };
  } catch {
    return { current: defaults(), history: [] };
  }
}

let state = load();

function persist() {
  fs.mkdirSync(path.dirname(BLOCKS_PATH), { recursive: true });
  const tmp = `${BLOCKS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, BLOCKS_PATH);
}

function get() {
  return state.current;
}

function remember(label) {
  state.history.unshift({ id: crypto.randomBytes(5).toString('hex'), at: new Date().toISOString(), label, config: state.current });
  state.history = state.history.slice(0, HISTORY_MAX);
}

// Блок целиком заменяется присланным (недостающие поля — из умолчаний).
function updateBlock(block, value) {
  remember(`До правки: ${BLOCK_NAMES[block] || block}`);
  state.current = { ...state.current, [block]: merge(defaults()[block], value) };
  persist();
  return state.current;
}

function history() {
  return state.history.map(({ id, at, label }) => ({ id, at, label }));
}

function rollback(id) {
  const v = state.history.find((h) => h.id === id);
  if (!v) return null;
  remember('До отката');
  state.current = merge(defaults(), v.config);
  persist();
  return state.current;
}

module.exports = { get, updateBlock, history, rollback, defaults, BLOCK_NAMES, BLOCKS_PATH };
