// Проставляет imageUrl чаям, для которых в витрине лежит фото assets/teas/<id>.jpg.
// На старом сервере это было сделано вручную через API и пропало вместе с ним.
// Запуск: SITE_DIR=/var/www/chainy-gorod-site node restore-images.js
const fs = require('fs');
const path = require('path');
const store = require('./store');

const SITE_DIR = process.env.SITE_DIR || '/var/www/chainy-gorod-site';
let n = 0;
for (const tea of store.getAll()) {
  const rel = `assets/teas/${tea.id}.jpg`;
  if (fs.existsSync(path.join(SITE_DIR, rel))) {
    if (tea.imageUrl !== rel) store.upsert(tea.id, { imageUrl: rel });
    n += 1;
  } else {
    console.log(`Нет фото для ${tea.id} (${tea.name}) — останется цветная плашка.`);
  }
}
console.log(`Фото проставлены: ${n} чаёв.`);
