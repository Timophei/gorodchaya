#!/usr/bin/env node
// Загрузка описаний из черновика редактора (import/opisaniya-*.json) в каталог.
//
//   node /opt/gorodchaya/backend/import-descriptions.js \
//     /opt/gorodchaya/backend/import/opisaniya-2026-10-22.json \
//     /opt/gorodchaya/backend/import/ostatki-2026-10-21.json
//   DRY=1 node ...   — только показать
//   FORCE=1 node ... — перезаписать и то, что уже правили в админке
//
// Сопоставление — по исходному названию из файла остатков (source.name_original
// ↔ поле sheet в файле остатков), не по названию на сайте.
// Что меняется: «Коротко», описание, заварка, температура воды, «Что сверить».
// Не трогается: название, адрес, цены, остатки, фото, регион.
// Карточки мастера (были до файла остатков) не трогаются никогда.
// Описание, которое уже правили в админке, без FORCE=1 не перезаписывается.
const fs = require('fs');

const [DESC_FILE, STOCK_FILE] = process.argv.slice(2);
if (!DESC_FILE || !STOCK_FILE) { console.error('Укажите файл описаний и файл остатков.'); process.exit(1); }
const DRY = process.env.DRY === '1';
const FORCE = process.env.FORCE === '1';
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
const KEY = apiKey();

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method, headers: { 'content-type': 'application/json', 'x-api-key': KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 404 && method === 'GET') return null;
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

function range(r, unit) {
  if (!r) return null;
  return r.min === r.max ? `${r.min}${unit}` : `${r.min}–${r.max}${unit}`;
}

function secondsText(r) {
  if (!r) return null;
  const { min, max } = r;
  if (min >= 60 && min % 30 === 0 && max % 30 === 0) {
    const m = (x) => String(x / 60).replace('.', ',');
    return `${m(min)}–${m(max)} мин`;
  }
  return `${min}–${max} секунд`;
}

// Структурный рецепт редактора -> три текста вкладки «Как заваривать».
function brewingTexts(b, weightGrams) {
  if (!b) return null;
  const t = range(b.water_temperature_c, ' °C');
  const out = {};
  if (b.gongfu) {
    const g = b.gongfu;
    out.gongfu_proliv = [
      `Около ${g.tea_g} г на ${g.water_ml} мл${t ? `, вода ${t}` : ''}.`,
      g.first_infusion_seconds ? `Первый пролив — ${secondsText(g.first_infusion_seconds)}.` : '',
      g.next_infusions || '',
    ].filter(Boolean).join(' ');
  }
  if (b.infusion) {
    const i = b.infusion;
    out.teapot_or_press = [
      `Около ${i.tea_g} г на ${i.water_ml} мл${t ? `, вода ${t}` : ''}, ${secondsText(i.time_seconds)}.`,
      'Настой полностью отделите от листа.',
      weightGrams && weightGrams <= 10 && b.portion_note ? b.portion_note : '',
    ].filter(Boolean).join(' ');
  }
  if (b.thermos) out.thermos = b.thermos;
  return { brewing: out, waterTemperature: t };
}

// Описание для покупателя: текст + состояние товара + для посуды объём,
// материал и конкретный уход (общую оговорку «сверить с инструкцией» не выводим).
function descriptionFor(p) {
  const parts = [p.description];
  if (p.condition_note && !norm(p.description).includes(norm(p.condition_note).replace(/\.$/, ''))) parts.push(p.condition_note);
  const specs = [];
  if (p.volume_ml) specs.push(`Объём: ${p.volume_ml} мл.`);
  if (p.material) specs.push(`Материал: ${p.material}.`);
  if (specs.length) parts.push(specs.join(' '));
  if (p.care && !/^Уход сверить/.test(p.care)) parts.push(`Уход: ${p.care.charAt(0).toLowerCase()}${p.care.slice(1)}`);
  return parts.filter(Boolean).join('\n\n');
}

// Снимок перед загрузкой — откат: bash /opt/gorodchaya/rollback.sh last
function snapshot() {
  const script = require('path').join(__dirname, '..', 'snapshot.sh');
  if (fs.existsSync(script)) require('child_process').execFileSync('bash', [script, 'before-descriptions'], { stdio: 'inherit' });
}

(async () => {
  if (!DRY) snapshot();
  const desc = JSON.parse(fs.readFileSync(DESC_FILE, 'utf8'));
  const stock = JSON.parse(fs.readFileSync(STOCK_FILE, 'utf8'));
  const bySheet = new Map();
  for (const r of stock.existing || []) bySheet.set(norm(r.sheet), { ...r, master: true });
  for (const r of stock.new || []) bySheet.set(norm(r.sheet), r);

  const done = []; const skipped = []; const unmatched = [];
  for (const p of desc.products || []) {
    const name = p.source && p.source.name_original;
    const row = bySheet.get(norm(name));
    if (!row) { unmatched.push(name); continue; }
    if (row.master) { skipped.push(`${name} — карточка мастера, не трогаем`); continue; }
    const tea = await api('GET', `/teas/${encodeURIComponent(row.id)}`);
    if (!tea) { unmatched.push(`${name} (нет на сайте: ${row.id})`); continue; }
    const untouched = !tea.description || norm(tea.description) === norm(row.description);
    if (!untouched && !FORCE) { skipped.push(`${tea.name} — описание уже правили в админке (FORCE=1, чтобы заменить)`); continue; }

    const patch = {
      id: tea.id, name: tea.name, category: tea.category,
      shortDescription: p.short_description || null,
      description: descriptionFor(p),
      reviewNotes: (p.review && Array.isArray(p.review.notes)) ? p.review.notes.slice(0, 20) : [],
    };
    const w = (tea.prices && tea.prices[0] && tea.prices[0].weightGrams) || 0;
    const br = tea.category === 'teaware' ? null : brewingTexts(p.brewing, w);
    if (br) { patch.brewing = br.brewing; if (br.waterTemperature) patch.waterTemperature = br.waterTemperature; }
    done.push(tea.name);
    if (!DRY) await api('POST', '/teas', patch);
  }

  console.log(`Обновлено${DRY ? ' (DRY — ничего не записано)' : ''}: ${done.length}`);
  done.forEach((n) => console.log(`  ✓ ${n}`));
  if (skipped.length) { console.log(`Пропущено: ${skipped.length}`); skipped.forEach((n) => console.log(`  – ${n}`)); }
  if (unmatched.length) { console.log(`Не сопоставлено: ${unmatched.length}`); unmatched.forEach((n) => console.log(`  ? ${n}`)); }
})().catch((e) => { console.error(e.message); process.exit(1); });
