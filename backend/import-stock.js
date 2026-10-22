#!/usr/bin/env node
// Разовая загрузка цен и остатков из файла остатков в работающий магазин.
//
//   node /opt/gorodchaya/backend/import-stock.js /opt/gorodchaya/backend/import/ostatki-2026-10-21.json
//   DRY=1 node ...   — только показать, что будет сделано
//
// Пишет через API бэкенда (а не в store.json напрямую): бэкенд держит каталог
// в памяти и перезаписал бы файл, а так он сам перепечёт страницы и базу мастера.
//
// existing — чаи, которые уже есть: ставится цена и остаток нужной фасовки,
//            остальные поля и другие фасовки не трогаются.
// new      — новые чаи с минимальным описанием. Если такой id уже есть
//            (повторный запуск), меняются только цена и остаток — тексты,
//            поправленные в админке, не затираются.
//
// Остаток задаётся как есть, а не прибавляется: повторный запуск вернёт цифры
// файла, поэтому после первых продаж запускать его снова не нужно.
const fs = require('fs');

const FILE = process.argv[2];
if (!FILE) { console.error('Укажите файл: node import-stock.js import/ostatki-....json'); process.exit(1); }
const DRY = process.env.DRY === '1';
const API = process.env.API_BASE || 'http://127.0.0.1:4000/api';

function apiKey() {
  if (process.env.API_KEY) return process.env.API_KEY;
  try {
    const line = fs.readFileSync('/etc/chainy-gorod-backend.env', 'utf8').split('\n').find((l) => l.startsWith('API_KEY='));
    if (line) return line.slice('API_KEY='.length).trim();
  } catch { /* нет файла */ }
  console.error('Нет API_KEY: запустите от root на сервере или передайте API_KEY=...');
  process.exit(1);
}
const KEY = DRY ? '' : apiKey();

// Минимальная заварка по виду чая — пока мастер не пришлёт свои карточки.
const BY_CATEGORY = {
  green: { water: '75–80 °C', brewing: {
    gongfu_proliv: 'Около 4–5 г на 150 мл, вода 75–80 °C. Первые проливы 10–15 секунд, дальше понемногу дольше.',
    teapot_or_press: 'Около 3–4 г на 300 мл, вода 75–80 °C, 2–3 минуты. Настой отделите от листа.',
  } },
  white: { water: '85–90 °C', brewing: {
    gongfu_proliv: 'Около 5 г на 150 мл, вода 85–90 °C. Проливы от 15–20 секунд, дальше дольше.',
    teapot_or_press: 'Около 4 г на 400 мл, вода 85–90 °C, 3–5 минут.',
  } },
  oolong: { water: '90–95 °C', brewing: {
    gongfu_proliv: 'Около 6–7 г на 150 мл, вода 90–95 °C. Первые проливы короткие, 5–10 секунд, дальше дольше.',
    teapot_or_press: 'Около 4–5 г на 500 мл, вода 90–95 °C, 3–4 минуты. Настой отделите от листа.',
  } },
  black: { water: '90–95 °C', brewing: {
    gongfu_proliv: 'Около 5 г на 150 мл, вода 90–95 °C. Проливы 5–10 секунд, дальше дольше.',
    teapot_or_press: 'Около 4 г на 400 мл, вода 90–95 °C, 3–4 минуты.',
  } },
  puer: { water: '95–100 °C', brewing: {
    gongfu_proliv: 'Около 6–7 г на 150 мл, вода 95–100 °C. Лист один раз быстро промойте кипятком, дальше проливы от 5–10 секунд.',
    teapot_or_press: 'Около 4–5 г на 500 мл. Промойте лист кипятком, залейте снова и настаивайте 3–5 минут.',
  } },
};
const CATEGORY_LABELS = { green: 'Зелёный чай', black: 'Чёрный чай', oolong: 'Улун', puer: 'Пуэр', white: 'Белый чай', yellow: 'Жёлтый чай', herbal: 'Травяной сбор', teaware: 'Посуда' };

// Перед загрузкой — снимок данных, чтобы откатить: bash /opt/gorodchaya/rollback.sh
function snapshot() {
  const script = require('path').join(__dirname, '..', 'snapshot.sh');
  if (!fs.existsSync(script)) return;
  require('child_process').execFileSync('bash', [script, 'before-import'], { stdio: 'inherit' });
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return data;
}

function withWeight(prices, row) {
  const out = (prices || []).map(({ weightGrams, price, stock }) => ({ weightGrams, price, stock: stock ?? null }));
  const entry = out.find((p) => p.weightGrams === row.weightGrams);
  if (entry) { entry.price = row.price; entry.stock = row.stock; }
  else out.push({ weightGrams: row.weightGrams, price: row.price, stock: row.stock });
  return out.sort((a, b) => a.weightGrams - b.weightGrams);
}

async function setPrice(tea, row, label) {
  const old = (tea.prices || []).find((p) => p.weightGrams === row.weightGrams);
  const was = old ? `${old.price} ₽, ост. ${old.stock ?? '—'}` : 'нет фасовки';
  console.log(`  ${label} ${tea.name}, ${row.weightGrams ? `${row.weightGrams} г` : 'шт'}: ${was} → ${row.price} ₽, ост. ${row.stock}`);
  if (DRY) return;
  await api('POST', '/teas', { id: tea.id, name: tea.name, category: tea.category, prices: withWeight(tea.prices, row) });
}

(async () => {
  const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  if (!DRY) snapshot();
  let updated = 0; let created = 0; const missing = [];

  console.log('Уже были на сайте:');
  for (const row of data.existing || []) {
    const tea = await api('GET', `/teas/${encodeURIComponent(row.id)}`);
    if (!tea) { missing.push(`${row.id} (${row.sheet})`); continue; }
    await setPrice(tea, row, '~');
    updated += 1;
  }

  console.log('Новые:');
  for (const row of data.new || []) {
    const tea = await api('GET', `/teas/${encodeURIComponent(row.id)}`);
    if (tea) { await setPrice(tea, row, '~'); updated += 1; continue; }
    const kind = BY_CATEGORY[row.category] || {};
    console.log(`  + ${row.name}, ${row.weightGrams ? `${row.weightGrams} г` : 'шт'}: ${row.price} ₽, ост. ${row.stock}`);
    created += 1;
    if (DRY) continue;
    await api('POST', '/teas', {
      id: row.id,
      name: row.name,
      subtitle: row.subtitle || null,
      category: row.category,
      categoryLabel: CATEGORY_LABELS[row.category],
      region: row.region || null,
      regionLabel: row.regionLabel || null,
      description: row.description || null,
      waterTemperature: kind.water || null,
      brewing: kind.brewing || {},
      contraindications: ['herbal', 'teaware'].includes(row.category) ? [] : ['содержит кофеин'],
      prices: [{ weightGrams: row.weightGrams, price: row.price, stock: row.stock }],
    });
  }

  console.log(`\nГотово${DRY ? ' (DRY — ничего не записано)' : ''}: обновлено ${updated}, добавлено ${created}.`);
  if (missing.length) console.log(`Не нашлись на сайте (пропущены): ${missing.join('; ')}`);
  if (!DRY) console.log('Страницы и база мастера перепекутся сами через пару секунд.');
})().catch((e) => { console.error(e.message); process.exit(1); });
