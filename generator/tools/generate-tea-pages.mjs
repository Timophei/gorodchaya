#!/usr/bin/env node
/*
 * Чайный город — генератор индексируемых страниц товара.
 *
 * Зачем: catalog.html/product.html раньше отдавали пустой каркас и тянули
 * данные через fetch() уже в браузере. Google такое в итоге разбирает (хотя
 * и со второй, отложенной волной обхода), а вот Яндекс — для .ru-магазина
 * обычно более важный поисковик — JS исполняет гораздо менее надёжно. Этот
 * скрипт печёт по одному настоящему HTML-файлу на каждый чай — tea-<id>.html
 * — где название, описание, характеристики и цена уже лежат в самой
 * разметке, плюс разметка Product/Offer (schema.org) для расширенных
 * сниппетов. Разметку строит src/assets/common.js (renderProductMarkup) —
 * тот же код, что рисует карточку в браузере, — так что если карточки
 * поменяют, страницы просто перегенерируются в новом виде без правок здесь.
 *
 * Запуск на сервере (там же, где крутится shop-api и лежит сама витрина):
 *
 *   node tools/generate-tea-pages.mjs
 *
 * Переменные окружения (все необязательны, показаны значения по умолчанию):
 *   API_BASE=http://127.0.0.1:4000/api   # бэкенд напрямую, в обход nginx/https
 *   SITE_ORIGIN=https://gorodchaya.ru    # для canonical/OG/sitemap.xml
 *                                        # (пока магазин на /shop/, укажите
 *                                        # SITE_ORIGIN=https://gorodchaya.ru/shop —
 *                                        # после переезда на корень домена
 *                                        # убрать /shop и просто перегенерировать)
 *   OUT_DIR=<репозиторий>/dist           # куда класть tea-*.html + sitemap.xml
 *                                        # (на сервере — папка витрины, напр.
 *                                        # /var/www/chainy-gorod-site)
 *   ASSET_VERSION=3                      # ?v= у assets/style.css и common.js —
 *                                        # держите тем же числом, что стоит в
 *                                        # <link>/<script> на остальных .html,
 *                                        # иначе браузеры будут кэшировать
 *                                        # старую версию после каждого деплоя
 *
 * Перезапускать нужно каждый раз, когда меняются чаи (руками или по cron,
 * например раз в час) — свежих данных без перезапуска страницы не увидят.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CG = require('../src/assets/common.js');

const API_BASE = process.env.API_BASE || 'http://127.0.0.1:4000/api';
const SITE_ORIGIN = (process.env.SITE_ORIGIN || 'https://gorodchaya.ru').replace(/\/+$/, '');
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, '..', 'dist');
// Совпадает с ?v=3 в assets/style.css и assets/common.js на остальных страницах —
// поднимайте это число КАЖДЫЙ раз, когда меняете common.js/style.css, и тогда же
// поправьте ?v= в остальных .html (иначе браузеры продолжат отдавать старые
// файлы из кэша — именно это и было причиной "меню не обновилось").
const ASSET_VERSION = process.env.ASSET_VERSION || '20';

const FONT_LINK =
  '<link rel="preconnect" href="https://fonts.googleapis.com">\n' +
  '<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,600;0,700;1,500;1,600&family=Manrope:wght@400;500;600;700;800&display=swap" rel="stylesheet">';

// Тот же счётчик Яндекс.Метрики, что и на остальных страницах сайта (см.
// src/pages/*.html) — товарные страницы генерируются отдельно этим
// скриптом, поэтому счётчик сюда нужно вставлять отдельно, а не один раз.
const METRIKA_SNIPPET =
  '<!-- Yandex.Metrika counter -->\n' +
  '<script type="text/javascript">\n' +
  '    (function(m,e,t,r,i,k,a){\n' +
  '        m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};\n' +
  '        m[i].l=1*new Date();\n' +
  '        for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}\n' +
  '        k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)\n' +
  "    })(window, document,'script','https://mc.yandex.ru/metrika/tag.js?id=112293654', 'ym');\n\n" +
  "    ym(112293654, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:\"dataLayer\", referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true});\n" +
  '</script>\n' +
  '<noscript><div><img src="https://mc.yandex.ru/watch/112293654" style="position:absolute; left:-9999px;" alt="" /></div></noscript>\n' +
  '<!-- /Yandex.Metrika counter -->';

// Абсолютный URL картинки для превью в мессенджерах/соцсетях. У товара
// обычно есть своё фото (imageUrl, относительный путь вида
// "assets/teas/xxx.jpg") — используем его; если фото ещё нет, показываем
// фирменную карточку с логотипом вместо пустого превью.
function ogImageFor(tea) {
  const fallback = SITE_ORIGIN + '/assets/og-share.jpg';
  if (!tea.imageUrl) return fallback;
  if (/^https?:\/\//.test(tea.imageUrl)) return tea.imageUrl;
  return SITE_ORIGIN + '/' + String(tea.imageUrl).replace(/^\/+/, '');
}

function log(msg) { console.log('[generate-tea-pages] ' + msg); }

async function fetchJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
  return res.json();
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function metaDescriptionFor(tea) {
  const base = stripTags(tea.description) || stripTags(tea.subtitle) || (CG.categoryLabel(tea) + ' в каталоге «Чайного города».');
  if (base.length <= 155) return base;
  const cut = base.slice(0, 155);
  return cut.slice(0, cut.lastIndexOf(' ')) + '…';
}

function jsonLdFor(tea) {
  const data = {
    '@context': 'https://schema.org/',
    '@type': 'Product',
    name: tea.name,
    description: stripTags(tea.description) || stripTags(tea.subtitle) || undefined,
    category: CG.categoryLabel(tea) || undefined
  };
  if (tea.minPrice != null) {
    data.offers = {
      '@type': 'Offer',
      priceCurrency: 'RUB',
      price: String(tea.minPrice),
      availability: (tea.prices || []).some((p) => p.stock > 0) ? 'https://schema.org/InStock' : 'https://schema.org/BackOrder',
      url: SITE_ORIGIN + '/' + CG.defaultTeaHref(tea)
    };
  }
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

function embeddedJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function pageHtml(tea, allTeas) {
  const id = tea.id;
  // SEO-заголовок и описание задаются в админке; пустые — собираем сами.
  const title = tea.seoTitle
    ? CG.escapeHtml(tea.seoTitle)
    : CG.escapeHtml(tea.name) + ' — купить ' + CG.escapeHtml((CG.categoryLabel(tea) || 'чай').toLowerCase()) + ' | Чайный город';
  const description = CG.escapeHtml(tea.seoDescription || metaDescriptionFor(tea));
  const canonical = SITE_ORIGIN + '/' + CG.defaultTeaHref(tea);
  const related = CG.relatedMarkup(allTeas, tea);

  return (
    '<!doctype html>\n<html lang="ru">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    // Страница живёт по адресу /tea/<slug>: все относительные ссылки и стили — от корня.
    '<base href="/">\n' +
    '<title>' + title + '</title>\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<meta name="description" content="' + description + '">\n' +
    '<link rel="canonical" href="' + canonical + '">\n' +
    '<meta property="og:type" content="product">\n' +
    '<meta property="og:title" content="' + title + '">\n' +
    '<meta property="og:description" content="' + description + '">\n' +
    '<meta property="og:url" content="' + canonical + '">\n' +
    '<meta property="og:image" content="' + ogImageFor(tea) + '">\n' +
    '<meta name="twitter:card" content="summary_large_image">\n' +
    '<meta name="twitter:title" content="' + title + '">\n' +
    '<meta name="twitter:description" content="' + description + '">\n' +
    '<meta name="twitter:image" content="' + ogImageFor(tea) + '">\n' +
    FONT_LINK + '\n' +
    '<link rel="stylesheet" href="assets/style.css?v=' + ASSET_VERSION + '">\n' +
    '<script type="application/ld+json">' + jsonLdFor(tea) + '</script>\n' +
    METRIKA_SNIPPET + '\n' +
    '</head>\n' +
    '<body data-nav="catalog">\n' +
    '<div id="site-header">' + CG.headerHtml('catalog') + '</div>\n' +
    '<div class="crumbs wrap">\n' +
    '  <a href="index.html">Главная</a> &nbsp;/&nbsp;\n' +
    '  <a href="catalog.html">Каталог</a> &nbsp;/&nbsp;\n' +
    '  <span class="current" id="crumb-name">' + CG.escapeHtml(tea.name) + '</span>\n' +
    '</div>\n' +
    '<main class="wrap container-pad" id="product-root" style="padding-top:24px;padding-bottom:40px;">\n' +
    CG.renderProductMarkup(tea, { qty: 1, tab: 'desc' }) +
    '\n</main>\n' +
    '<section class="wrap container-pad" style="padding-bottom:56px;' + (related.html ? '' : 'display:none;') + '">\n' +
    '  <div class="serif" style="font-size:22px;font-weight:700;margin-bottom:18px;">' + (CG.isTeaware(tea) ? 'С этим часто берут' : 'С этим чаем часто берут') + '</div>\n' +
    '  <div class="grid-4" id="related-grid">' + related.html + '</div>\n' +
    '</section>\n' +
    '<div id="site-footer">' + CG.footerHtml() + '</div>\n' +
    '<script src="assets/common.js?v=' + ASSET_VERSION + '"></script>\n' +
    '<script>\n' +
    'window.__TEA__ = ' + embeddedJson(tea) + ';\n' +
    'window.__RELATED__ = ' + embeddedJson(allTeas) + ';\n' +
    '(function () {\n' +
    '  function boot() { window.ChayGorod.mountProduct(window.__TEA__, window.__RELATED__); }\n' +
    '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();\n' +
    '})();\n' +
    '</script>\n' +
    '</body>\n</html>\n'
  );
}

function buildSitemap(teas) {
  const staticUrls = ['/', '/catalog.html', '/guild.html', '/about.html'];
  const teaUrls = teas.filter((t) => t.slug).map((t) => '/' + CG.defaultTeaHref(t));
  const urls = staticUrls.concat(teaUrls);
  const today = new Date().toISOString().slice(0, 10);
  const body = urls.map((u) =>
    '  <url><loc>' + SITE_ORIGIN + u + '</loc><lastmod>' + today + '</lastmod></url>'
  ).join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + body + '\n</urlset>\n';
}

function ensureRobotsTxt() {
  const p = path.join(OUT_DIR, 'robots.txt');
  const sitemapLine = 'Sitemap: ' + SITE_ORIGIN + '/sitemap.xml';
  if (fs.existsSync(p)) {
    const current = fs.readFileSync(p, 'utf8');
    if (current.includes('Sitemap:')) {
      log('robots.txt уже существует и содержит Sitemap: — не трогаю.');
      return;
    }
    fs.writeFileSync(p, current.replace(/\s*$/, '') + '\n\n' + sitemapLine + '\n');
    log('Добавил строку Sitemap: в существующий robots.txt.');
    return;
  }
  const def = 'User-agent: *\nAllow: /\nDisallow: /product.html\n\n' + sitemapLine + '\n';
  fs.writeFileSync(p, def);
  log('Создал robots.txt.');
}

async function main() {
  log('API_BASE=' + API_BASE);
  log('SITE_ORIGIN=' + SITE_ORIGIN);
  log('OUT_DIR=' + OUT_DIR);

  if (!fs.existsSync(OUT_DIR)) {
    throw new Error('OUT_DIR не найден: ' + OUT_DIR + ' — проверьте переменную окружения OUT_DIR.');
  }

  const teas = await fetchJson(API_BASE + '/teas');
  if (!Array.isArray(teas) || !teas.length) {
    throw new Error('API вернул пустой или некорректный список чаёв (' + API_BASE + '/teas)');
  }
  log('Получено чаёв: ' + teas.length);

  // Страницы товара: OUT_DIR/tea/<slug>.html, адрес — /tea/<slug>
  // (nginx: try_files $uri.html). Чай без slug пропускаем — бэкенд проставляет
  // адреса при старте, так что это только совсем старые данные.
  const teaDir = path.join(OUT_DIR, 'tea');
  fs.mkdirSync(teaDir, { recursive: true });
  let written = 0;
  const currentFiles = new Set();
  for (const tea of teas) {
    if (!tea || !tea.id || !tea.slug) { if (tea) log('Нет адреса (slug), пропущен: ' + tea.id); continue; }
    const fileName = tea.slug + '.html';
    const tmp = path.join(teaDir, '.' + fileName + '.tmp');
    fs.writeFileSync(tmp, pageHtml(tea, teas));
    fs.renameSync(tmp, path.join(teaDir, fileName));
    currentFiles.add(fileName);
    written++;
  }
  log('Записано страниц товара: ' + written);

  // Удалённые и переименованные чаи: убираем их файлы. Старые адреса не
  // пропадают — nginx отправляет их в бэкенд, а тот делает редирект на новый.
  let removed = 0;
  for (const entry of fs.readdirSync(teaDir)) {
    if (!/\.html$/.test(entry) || currentFiles.has(entry)) continue;
    fs.unlinkSync(path.join(teaDir, entry));
    removed++;
  }
  // Страницы старого формата tea-<id>.html в корне больше не нужны.
  for (const entry of fs.readdirSync(OUT_DIR)) {
    if (!/^tea-.+\.html$/.test(entry)) continue;
    fs.unlinkSync(path.join(OUT_DIR, entry));
    removed++;
  }
  if (removed) log('Удалено устаревших страниц товара: ' + removed);

  fs.writeFileSync(path.join(OUT_DIR, 'sitemap.xml'), buildSitemap(teas));
  log('sitemap.xml обновлён (' + (teas.length + 4) + ' адресов).');

  ensureRobotsTxt();
  log('Готово.');
}

main().catch((err) => {
  console.error('[generate-tea-pages] ОШИБКА:', err.message);
  process.exit(1);
});
