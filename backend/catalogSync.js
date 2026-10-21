// Всё, что должно происходить после правки каталога в админке:
//  - у каждого чая есть красивый адрес (slug) и номер (externalId);
//  - база знаний мастера (tea-consultant/data/teas.json) выгружается из каталога;
//  - статические страницы tea/<slug>.html и sitemap.xml перепекаются генератором.
// Пути по умолчанию — серверные; на машине разработчика их просто нет,
// и соответствующие шаги пропускаются с сообщением в лог.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');

const SITE_DIR = process.env.SITE_DIR || '/var/www/chainy-gorod-site';
const GENERATOR = process.env.GENERATOR_PATH || '/opt/chainy-gorod-generator/tools/generate-tea-pages.mjs';
const CONSULTANT_KB = process.env.CONSULTANT_KB_PATH || '/var/www/tea-consultant/data/teas.json';
const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://gorodchaya.ru';

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function slugify(text) {
  const s = String(text || '')
    .toLowerCase()
    .split('')
    .map((c) => (Object.prototype.hasOwnProperty.call(TRANSLIT, c) ? TRANSLIT[c] : c))
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length <= 60) return s || 'tea';
  return s.slice(0, 60).replace(/-[^-]*$/, '') || s.slice(0, 60);
}

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function slugTaken(slug, exceptId) {
  const owner = store.getBySlug(slug) || store.getByOldSlug(slug);
  return !!owner && owner.id !== exceptId;
}

function uniqueSlug(base, exceptId) {
  let slug = base;
  for (let i = 2; slugTaken(slug, exceptId); i += 1) slug = `${base}-${i}`;
  return slug;
}

function nextExternalId() {
  const nums = store.getAll().map((t) => parseInt(t.externalId, 10)).filter((n) => Number.isFinite(n));
  return String(nums.length ? Math.max(...nums) + 1 : 101);
}

// Разовая миграция: чаи без slug/номера (заведённые до этой версии) получают их.
function ensureSlugsAndNumbers() {
  let changed = 0;
  for (const t of store.getAll().sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))) {
    const patch = {};
    if (!t.slug || !SLUG_RE.test(t.slug)) patch.slug = uniqueSlug(slugify(t.name || t.id), t.id);
    if (!t.externalId) patch.externalId = nextExternalId();
    if (Object.keys(patch).length) { store.upsert(t.id, patch); changed += 1; }
  }
  if (changed) console.log(`Каталог: проставлены адреса/номера у ${changed} чаёв.`);
}

// Чай магазина -> запись базы знаний мастера (формат tea-consultant/data/teas.json).
function toConsultant(t) {
  return {
    id: parseInt(t.externalId, 10),
    name: t.name,
    subtitle: t.subtitle || null,
    region: t.regionLabel || null,
    description: t.description || null,
    taste: t.taste || [],
    taste_note: t.tasteNote || null,
    situations: t.situations || [],
    effects_note: t.effectsNote || null,
    liquor_color: t.liquorColor || null,
    water_temperature: t.waterTemperature || null,
    vessels: t.vessels || [],
    brewing: t.brewing || {},
    contraindications: t.contraindications || [],
    city_opinion: t.cityOpinion || null,
  };
}

function exportConsultantKb() {
  if (!fs.existsSync(path.dirname(CONSULTANT_KB))) {
    console.log(`База мастера: нет ${path.dirname(CONSULTANT_KB)}, выгрузка пропущена.`);
    return;
  }
  const items = store.getAll()
    .filter((t) => Number.isFinite(parseInt(t.externalId, 10)))
    .sort((a, b) => parseInt(a.externalId, 10) - parseInt(b.externalId, 10))
    .map(toConsultant);
  const tmp = `${CONSULTANT_KB}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2) + '\n');
  fs.renameSync(tmp, CONSULTANT_KB);
}

const status = { lastRunAt: null, ok: null, message: 'ещё не запускалось', running: false };
let timer = null;
let rerun = false;

function runGenerator(port) {
  return new Promise((resolve) => {
    if (!fs.existsSync(GENERATOR)) return resolve({ ok: false, message: `нет генератора ${GENERATOR}` });
    execFile(process.execPath, [GENERATOR], {
      env: { ...process.env, OUT_DIR: SITE_DIR, SITE_ORIGIN, API_BASE: `http://127.0.0.1:${port}/api` },
      timeout: 60000,
    }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, message: (stderr || err.message).trim().split('\n').slice(-3).join(' ') });
      const line = String(stdout).split('\n').find((l) => l.includes('Записано страниц'));
      resolve({ ok: true, message: line ? line.replace(/\[generate-tea-pages\]\s*/, '').toLowerCase() : 'готово' });
    });
  });
}

async function syncNow(port) {
  if (status.running) { rerun = true; return; }
  status.running = true;
  const messages = [];
  let ok = true;
  try {
    exportConsultantKb();
    messages.push('база мастера обновлена');
  } catch (e) {
    ok = false;
    messages.push(`база мастера: ${e.message}`);
  }
  const gen = await runGenerator(port);
  ok = ok && gen.ok;
  messages.push(gen.ok ? `страницы: ${gen.message}` : `страницы: ${gen.message}`);
  Object.assign(status, { lastRunAt: new Date().toISOString(), ok, message: messages.join('; '), running: false });
  console.log(`Синхронизация каталога: ${status.message}`);
  if (rerun) { rerun = false; syncNow(port); }
}

// Вызывается после каждой правки; несколько правок подряд склеиваются в один прогон.
function onCatalogChanged(port) {
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(port), 800);
}

module.exports = {
  SITE_DIR, SITE_ORIGIN, SLUG_RE,
  slugify, uniqueSlug, slugTaken, nextExternalId, ensureSlugsAndNumbers,
  onCatalogChanged, syncNow, status, toConsultant,
};
