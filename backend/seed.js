// Seeds the DB with the REAL tea knowledge-base content — this time actually
// real: transcribed 2026-09-28 from the tea master's own working reference
// (10 product cards, docx). The previous version of this file claimed to
// pull "real" content from /var/www/tea-consultant/data/teas.json, but what
// it actually contained was approximated placeholder text (similar in
// structure, wrong in specifics — e.g. no real prices, no "Мнение Города",
// slightly different tasting notes/temperatures). This file replaces that
// with the master's actual data, including real prices — the old file never
// had any, since its source had none.
//
// Card №5 in the master's file is "Хуо Шань Хуан Я" (yellow tea), not
// "Моли Хуа Ча" (jasmine) as the header of the 10-card list claimed. Per the
// owner's decision (2026-09-28): the jasmine product (molihuacha) is fully
// replaced by the yellow tea (huoshanhuangya) — new id, new category, all
// fields from card №5. The old id is explicitly removed below so it doesn't
// linger as a dead product/page.
//
// Re-run any time with `npm run seed` — idempotent (upserts by id), and now
// safe to re-run freely: unlike before, this always sets the real prices
// from the master's data rather than preserving old empty pricing.
const store = require('./store');
const { CATEGORY_LABELS, REGION_LABELS, TEAS } = require('./seed-master-data');

// Товар, полностью замещённый жёлтым чаем (см. карточку №5 выше) — снимаем
// его явно, иначе id из старого каталога останется висеть в базе и как
// мёртвая статическая страница tea-molihuacha.html после генерации.
const REMOVED_IDS = ['molihuacha'];
for (const id of REMOVED_IDS) {
  if (store.remove(id)) {
    console.log(`Удалён замещённый товар: ${id}`);
  }
}

for (const t of TEAS) {
  store.upsert(t.id, {
    externalId: String(t.externalId),
    name: t.name,
    subtitle: t.subtitle || null,
    category: t.category,
    categoryLabel: CATEGORY_LABELS[t.category],
    region: t.region || null,
    regionLabel: t.regionLabel || (t.region ? REGION_LABELS[t.region] : null),
    description: t.description || null,
    taste: t.taste || [],
    tasteNote: t.tasteNote || null,
    situations: t.situations || [],
    effectsNote: t.effectsNote || null,
    liquorColor: t.liquorColor || null,
    waterTemperature: t.waterTemperature || null,
    vessels: t.vessels || [],
    brewing: t.brewing || {},
    contraindications: t.contraindications || [],
    cityOpinion: t.cityOpinion || null,
    featured: !!t.featured,
    // Реальные цены есть — в отличие от прежней версии этого файла, больше
    // не бережём "уже добавленную через API" цену: карточка мастера теперь
    // и есть источник истины по цене/фасовке.
    prices: t.prices || [],
  });
}

console.log(`Загружено ${TEAS.length} чаёв из настоящей базы мастера.`);
