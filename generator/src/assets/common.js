/* Чайный город — общая логика витрины: API, корзина, шапка/подвал, карточка товара.
   Файл написан так, чтобы работать и в браузере (window.ChayGorod), и в Node
   (через require) — вторая часть нужна скрипту генерации статических страниц
   чая (tools/generate-tea-pages.mjs), который печёт tea-<id>.html без браузера. */
(function (global, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api; // Node (require из генератора)
  }
  global.ChayGorod = api; // браузер
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  var API_BASE = '/shop-api/api';
  var CART_KEY = 'chaygorod_cart_v1';

  var CATEGORY_LABELS = { green: 'Зелёный чай', black: 'Чёрный чай', oolong: 'Улун', puer: 'Пуэр', white: 'Белый чай', yellow: 'Жёлтый чай', herbal: 'Травяной сбор', teaware: 'Посуда' };
  var REGION_LABELS = { china: 'Китай', japan: 'Япония', india: 'Индия', russia: 'Россия', thailand: 'Таиланд' };
  var CATEGORY_GRADIENTS = {
    green: 'linear-gradient(135deg,#7C9A5E,#A9C285)',
    black: 'linear-gradient(135deg,#4A3524,#6B4A30)',
    oolong: 'linear-gradient(135deg,#8E6A3E,#C79B57)',
    puer: 'linear-gradient(135deg,#3A2A1C,#5A3E28)',
    white: 'linear-gradient(135deg,#EDE6D2,#D8CBA0)',
    yellow: 'linear-gradient(135deg,#E4C55E,#F0DFA0)',
    herbal: 'linear-gradient(135deg,#B5432E,#8C3323)',
    teaware: 'linear-gradient(135deg,#8A8F86,#C4C7BD)'
  };

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatPrice(n) {
    if (n == null) return null;
    return Number(n).toLocaleString('ru-RU');
  }

  function gradientFor(tea) {
    return (tea && tea.gradient) || CATEGORY_GRADIENTS[tea && tea.category] || 'linear-gradient(135deg,#C9BE9F,#E3D9C2)';
  }

  // Инлайновый background для карточки товара: настоящее фото (imageUrl),
  // если оно есть, иначе прежняя плашка-градиент по категории.
  function photoStyleFor(tea) {
    return (tea && tea.imageUrl)
      ? 'background-image:url(' + escapeHtml(tea.imageUrl) + ');background-size:cover;background-position:center;'
      : 'background:' + gradientFor(tea) + ';';
  }

  function categoryLabel(tea) {
    return (tea && (tea.categoryLabel || CATEGORY_LABELS[tea.category])) || (tea && tea.category) || '';
  }

  function regionLabel(tea) {
    return (tea && (tea.regionLabel || REGION_LABELS[tea.region])) || (tea && tea.region) || '';
  }

  // Посуда продаётся поштучно: у её цены weightGrams = 0, граммов и заварки нет.
  function isTeaware(t) {
    return !!t && t.category === 'teaware';
  }

  function unitLabel(w) {
    return w ? w + ' г' : 'шт';
  }

  function fmtList(v) {
    if (Array.isArray(v)) return v.length ? v.join(', ') : '—';
    return v || '—';
  }

  function apiGet(path) {
    return fetch(API_BASE + path, { headers: { Accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  // Как apiGet, но POST с JSON-телом (см. оформление заказа в cart.html).
  // Cookie-сессия (вход через Telegram) едет автоматически — запрос идёт на
  // тот же origin, fetch сам подставляет cookie для same-origin запросов.
  function apiPost(path, body) {
    return fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) {
      return r.json().catch(function () { return null; }).then(function (data) {
        if (!r.ok) {
          var err = new Error((data && data.error) || ('HTTP ' + r.status));
          err.status = r.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  // ---------- вход через Telegram (см. account.html) ----------
  // Cookie-сессия, привязана к тому же origin, что и сама витрина (запрос
  // идёт на /shop-api/api/... того же домена) — fetch сам подставит cookie,
  // ничего дополнительно указывать не нужно.
  function authMe() {
    return fetch(API_BASE + '/auth/me', { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.status === 200 ? r.json() : null; })
      .then(function (d) { return d ? d.user : null; })
      .catch(function () { return null; });
  }

  function authLogout() {
    return fetch(API_BASE + '/auth/logout', { method: 'POST' }).then(function () { location.reload(); });
  }

  // ---------- метка посетителя и история просмотров ----------
  // cg_vid — случайная метка браузера (на год). По ней бэкенд копит, какие
  // страницы чаёв человек открывал, и связывает их с его диалогами и заказами
  // (админка, вкладка «Пользователи»). Как и buyClick — «выстрелил и забыл».
  function visitorId() {
    var m = document.cookie.match(/(?:^|; )cg_vid=([^;]*)/);
    if (m) return m[1];
    var bytes = new Uint8Array(16), id = '';
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    for (var i = 0; i < bytes.length; i++) id += ('0' + bytes[i].toString(16)).slice(-2);
    var expires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toUTCString();
    document.cookie = 'cg_vid=' + id + '; expires=' + expires + '; path=/; SameSite=Lax';
    return id;
  }

  function track() {
    try {
      visitorId();
      var tea = window.__TEA__ && window.__TEA__.id ? window.__TEA__.id : null;
      fetch(API_BASE + '/track', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ teaId: tea }),
        keepalive: true
      }).catch(function () {});
    } catch (e) { /* счётчик не должен ломать страницу */ }
  }

  // ---------- счётчик нажатий «Купить» (см. карточки под чатом) ----------
  // Не блокирует ничего на странице — «выстрелил и забыл», сервер сам
  // копит buyClicks по каждому чаю. Ошибку сети тут намеренно проглатываем:
  // счётчик — это соц.доказательство, а не критичная операция.
  function buyClick(teaId) {
    return fetch(API_BASE + '/teas/' + encodeURIComponent(teaId) + '/buy-click', { method: 'POST' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // ---------- cart (localStorage, client-side only — см. README) ----------
  function readCart() {
    try {
      var raw = localStorage.getItem(CART_KEY);
      var parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      return [];
    }
  }

  function writeCart(items) {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(items));
    } catch (e) {
      /* localStorage недоступен (приватный режим, квота) — корзина просто не сохранится */
    }
    updateCartBadges();
  }

  function cartCount() {
    return readCart().reduce(function (sum, it) { return sum + (it.qty || 0); }, 0);
  }

  function addToCart(tea, weight, qty) {
    qty = qty || 1;
    // «Купить» на мини-карточках (чат, «Популярные чаи») фасовку не передаёт —
    // берём самую дешёвую, ту же, по которой считается minPrice, чтобы в корзине
    // были видны граммы и они ушли в заказ.
    if (!weight && tea.prices && tea.prices.length) {
      var cheapest = tea.prices.reduce(function (a, b) { return b.price < a.price ? b : a; });
      weight = cheapest.weightGrams || null;
    }
    // Цена — именно выбранной фасовки (раньше всегда шла минимальная).
    var unitPrice = priceForWeight(tea, weight || 0);
    var id = tea.id + (weight ? ':' + weight : '');
    var items = readCart();
    var existing = items.find(function (it) { return it.lineId === id; });
    if (existing) {
      existing.qty = Math.min(20, existing.qty + qty);
    } else {
      items.push({
        lineId: id,
        teaId: tea.id,
        slug: tea.slug || null,
        name: tea.name,
        category: categoryLabel(tea),
        gradient: gradientFor(tea),
        imageUrl: tea.imageUrl || null,
        weight: weight || null,
        unitPrice: unitPrice != null ? unitPrice : (tea.minPrice || 0),
        qty: Math.min(20, qty)
      });
    }
    writeCart(items);
    return items;
  }

  function changeQty(lineId, delta) {
    var items = readCart().map(function (it) {
      return it.lineId === lineId ? Object.assign({}, it, { qty: Math.max(1, Math.min(20, it.qty + delta)) }) : it;
    });
    writeCart(items);
    return items;
  }

  function removeFromCart(lineId) {
    var items = readCart().filter(function (it) { return it.lineId !== lineId; });
    writeCart(items);
    return items;
  }

  function updateCartBadges() {
    if (typeof document === 'undefined') return;
    var count = cartCount();
    document.querySelectorAll('[data-cart-badge]').forEach(function (el) {
      el.textContent = String(count);
      el.style.display = count > 0 ? '' : 'none';
    });
  }

  // ---------- шапка / подвал ----------
  // 4 реальных раздела, у каждого — своя страница (для SEO и для людей).
  var NAV_LINKS = [
    { href: 'index.html', label: 'Чат', key: 'chat' },
    { href: 'catalog.html', label: 'Каталог', key: 'catalog' },
    { href: 'catalog.html?type=teaware', label: 'Посуда', key: 'teaware' },
    { href: 'guild.html', label: 'Гильдия', key: 'guild' },
    { href: 'about.html', label: 'О городе', key: 'about' }
  ];

  var HAMBURGER_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#20291F" stroke-width="1.9" stroke-linecap="round"><line x1="3" y1="7" x2="21" y2="7"></line><line x1="3" y1="12" x2="21" y2="12"></line><line x1="3" y1="17" x2="21" y2="17"></line></svg>';
  var CLOSE_SVG = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#20291F" stroke-width="1.9" stroke-linecap="round"><line x1="5" y1="5" x2="19" y2="19"></line><line x1="19" y1="5" x2="5" y2="19"></line></svg>';

  function headerHtml(active) {
    var navHtml = NAV_LINKS.map(function (l) {
      var cls = l.key === active ? ' class="active"' : '';
      return '<a href="' + l.href + '"' + cls + '>' + l.label + '</a>';
    }).join('\n      ');
    // На телефоне весь .header-actions (поиск/вход/корзина) и .main-nav
    // прячутся — вместо них один хамбургер, а все пункты (навигация +
    // поиск/вход/корзина) уходят в выезжающее мобильное меню.
    var mobileNavHtml = NAV_LINKS.map(function (l) {
      var cls = 'mobile-menu-item' + (l.key === active ? ' active' : '');
      return '<a class="' + cls + '" href="' + l.href + '">' + l.label + '</a>';
    }).join('');
    return (
      '<div class="site-header"><div class="site-header-inner wrap">' +
      '<a class="brand" href="index.html">' +
      '<img class="brand-logo" src="assets/logo-full.png" alt="Чайный город — авторский магазин">' +
      '</a>' +
      '<nav class="main-nav">\n      ' + navHtml + '\n      </nav>' +
      '<div class="header-actions">' +
      '<button class="icon-grp" type="button" title="Поиск">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#20291F" stroke-width="1.8" stroke-linecap="round"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.2" y2="16.2"></line></svg>' +
      '<span class="icon-label">Поиск</span></button>' +
      '<a class="icon-grp" href="account.html" style="text-decoration:none;" data-login-link>' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#20291F" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="3.6"></circle><path d="M4.5 20c1.2-4 4-6 7.5-6s6.3 2 7.5 6"></path></svg>' +
      '<span class="icon-label" data-login-label>Войти</span></a>' +
      '<a class="icon-grp cart-icon-wrap" href="cart.html" style="text-decoration:none;">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#20291F" stroke-width="1.8" stroke-linecap="round"><path d="M6 8h12l-1 12H7L6 8z"></path><path d="M9 8V6a3 3 0 0 1 6 0v2"></path></svg>' +
      '<span class="cart-badge" data-cart-badge></span>' +
      '<span class="icon-label">Корзина</span></a>' +
      '<div class="header-divider"></div>' +
      '<div class="header-quote serif">Хороший чай<br>собирает хороших людей<div class="header-quote-rule"></div></div>' +
      '<div class="avatar-dot"></div>' +
      '</div>' +
      '<button class="hamburger-btn" type="button" aria-label="Открыть меню" aria-expanded="false" data-menu-toggle>' + HAMBURGER_SVG + '</button>' +
      '</div>' +
      '<div class="mobile-menu-backdrop" data-menu-backdrop></div>' +
      '<div class="mobile-menu" data-mobile-menu>' +
      '<nav class="mobile-menu-nav">' + mobileNavHtml + '</nav>' +
      '<div class="mobile-menu-actions">' +
      '<button type="button" class="mobile-menu-item">Поиск</button>' +
      '<a class="mobile-menu-item" href="account.html" data-login-link>' +
      '<span data-login-label>Войти</span></a>' +
      '<a class="mobile-menu-item" href="cart.html">Корзина<span class="cart-badge" data-cart-badge></span></a>' +
      '</div>' +
      '</div>' +
      '</div>'
    );
  }

  function footerHtml() {
    return (
      '<div class="site-footer"><div class="site-footer-inner wrap">' +
      '<div class="foot-chat">' +
      '<div class="foot-chat-icon"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#22392B" stroke-width="1.9"><path d="M21 11.5a8.4 8.4 0 0 1-8.4 8.4c-1.3 0-2.5-.28-3.6-.8L3 20l1-5.2A8.4 8.4 0 1 1 21 11.5z"></path></svg></div>' +
      '<div><div class="foot-title">Чат с мастером</div><div class="foot-sub">Задайте вопрос</div></div>' +
      '</div>' +
      '<a class="foot-item" href="catalog.html" style="text-decoration:none;">' +
      '<div class="foot-item-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22392B" stroke-width="1.9"><path d="M4 8h16l-1.5 12h-13L4 8z"></path><path d="M8 8V6a4 4 0 0 1 8 0v2"></path></svg></div>' +
      '<div><div class="foot-item-title">Каталог</div><div class="foot-item-sub">Тысячи чаёв</div></div>' +
      '</a>' +
      '<a class="foot-item" href="guild.html" style="text-decoration:none;">' +
      '<div class="foot-item-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22392B" stroke-width="1.9"><circle cx="8.5" cy="8" r="2.6"></circle><circle cx="15.5" cy="8" r="2.6"></circle><path d="M2.5 19c.8-3 3-4.8 6-4.8s5.2 1.8 6 4.8M12.5 19c.7-2.6 2.6-4.2 5.2-4.2s4.5 1.6 5.2 4.2"></path></svg></div>' +
      '<div><div class="foot-item-title">Гильдия</div><div class="foot-item-sub">Люди и традиции</div></div>' +
      '</a>' +
      '<a class="foot-item" href="about.html" style="text-decoration:none;">' +
      '<div class="foot-item-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#22392B" stroke-width="1.9"><path d="M4 11.5 12 5l8 6.5"></path><path d="M6 10.5V20h12v-9.5"></path><path d="M10 20v-6h4v6"></path></svg></div>' +
      '<div><div class="foot-item-title">О городе</div><div class="foot-item-sub">Наш путь и ценности</div></div>' +
      '</a>' +
      '</div></div>'
    );
  }

  // ---------- персональные данные: документы в подвале и уведомление о cookie ----------
  // Оператор подставляется при установке (apply.sh) — одна точка правды для
  // подвала; сами документы лежат в privacy.html и consent.html.
  var OPERATOR_NAME = '{{OPERATOR}}';

  function legalHtml() {
    return (
      '<div class="legal-line"><div class="wrap">' +
      escapeHtml(OPERATOR_NAME) + ' · ' +
      '<a href="privacy.html">Политика конфиденциальности</a> · ' +
      '<a href="consent.html">Согласие на обработку персональных данных</a>' +
      '</div></div>'
    );
  }

  function mountCookieNotice() {
    try { if (localStorage.getItem('cg_cookie_ok')) return; } catch (e) { return; }
    var bar = document.createElement('div');
    bar.className = 'cookie-notice';
    bar.innerHTML =
      '<div class="cookie-notice-text">Сайт использует cookie и Яндекс.Метрику, а также запоминает, какие чаи вы открывали, ' +
      'чтобы мастер мог лучше вам помочь. Продолжая пользоваться сайтом, вы соглашаетесь с ' +
      '<a href="privacy.html">политикой конфиденциальности</a>.</div>' +
      '<button type="button" class="cookie-notice-btn">Понятно</button>';
    bar.querySelector('button').addEventListener('click', function () {
      try { localStorage.setItem('cg_cookie_ok', '1'); } catch (e) {}
      bar.parentNode.removeChild(bar);
    });
    document.body.appendChild(bar);
  }

  function mountChrome(active) {
    if (typeof document === 'undefined') return;
    var h = document.getElementById('site-header');
    var f = document.getElementById('site-footer');
    if (h) h.innerHTML = headerHtml(active);
    if (f) f.innerHTML = footerHtml() + legalHtml();
    updateCartBadges();
    mountCookieNotice();

    // Подставляем имя вместо "Войти" в шапке, если пользователь уже вошёл
    // через Telegram — сразу в обеих версиях (десктопной и в мобильном меню).
    var loginLabels = document.querySelectorAll('[data-login-label]');
    if (loginLabels.length) {
      authMe().then(function (user) {
        if (!user) return;
        loginLabels.forEach(function (el) { el.textContent = user.firstName || 'Кабинет'; });
      });
    }

    // Мобильное меню-гамбургер: один тумблер открывает/закрывает выезжающую
    // панель со всеми пунктами (навигация + поиск/вход/корзина), которые на
    // телефоне не помещаются в строку шапки.
    var toggle = document.querySelector('[data-menu-toggle]');
    var menu = document.querySelector('[data-mobile-menu]');
    var backdrop = document.querySelector('[data-menu-backdrop]');
    if (toggle && menu && backdrop) {
      var closeMenu = function () {
        menu.classList.remove('open');
        backdrop.classList.remove('open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.innerHTML = HAMBURGER_SVG;
        document.body.classList.remove('menu-open');
      };
      var openMenu = function () {
        menu.classList.add('open');
        backdrop.classList.add('open');
        toggle.setAttribute('aria-expanded', 'true');
        toggle.innerHTML = CLOSE_SVG;
        document.body.classList.add('menu-open');
      };
      toggle.addEventListener('click', function () {
        if (menu.classList.contains('open')) closeMenu(); else openMenu();
      });
      backdrop.addEventListener('click', closeMenu);
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeMenu();
      });
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', function () {
      var nav = document.body.getAttribute('data-nav');
      if (nav === 'catalog' && /[?&]type=teaware\b/.test(location.search)) nav = 'teaware';
      mountChrome(nav);
      track();
    });
  }

  // ---------- карточка товара: разметка + интерактив ----------
  // Вынесено в общий файл, чтобы ОДИН и тот же код строил разметку и
  // "живьём" (product.html — грузит товар через fetch) и "заранее"
  // (генератор tea-<id>.html — печёт готовый HTML для поисковиков без JS,
  // а этот же renderProductMarkup потом используется в браузере для
  // интерактива). Так карточки можно менять в одном месте.
  var WEIGHTS = [50, 100, 250];
  var TAB_LABELS = [
    { key: 'desc', label: 'Описание' },
    { key: 'specs', label: 'Ещё детали' },
    { key: 'brew', label: 'Как заваривать' }
  ];
  var BREW_LABELS = { gongfu_proliv: 'Гунфу-пролив', teapot_or_press: 'Чайник / френч-пресс', thermos: 'Термос' };

  // Фасовка по граммам; у посуды и у товара с одной фасовкой — единственная.
  function priceEntry(tea, w) {
    var prices = tea && Array.isArray(tea.prices) ? tea.prices : [];
    var found = prices.find(function (p) { return (p.weightGrams || 0) === (w || 0); });
    if (!found && !w && prices.length === 1) found = prices[0];
    return found || null;
  }

  function priceForWeight(tea, w) {
    if (!w && priceEntry(tea, w)) return priceEntry(tea, w).price;
    if (Array.isArray(tea.prices) && tea.prices.length) {
      // Поле у бэкенда называется weightGrams (см. TeaSchema в server.js) —
      // раньше тут стояло p.weight, которое всегда undefined, поэтому кнопки
      // выбора веса на странице товара никогда не меняли цену.
      var found = tea.prices.find(function (p) { return p.weightGrams === w; });
      if (found) return found.price;
    }
    return tea.minPrice;
  }

  function stockForWeight(tea, w) {
    var p = priceEntry(tea, w);
    return p && typeof p.stock === 'number' ? p.stock : 0;
  }

  // Реальные чаи мастера почти все продаются в ОДНОЙ конкретной фасовке
  // (25 г, 100 г, 200 г — какая есть), а не тремя универсальными весами.
  // Раньше пилюли веса всегда показывали фиксированный [50,100,250], и
  // выбор по умолчанию всегда падал на 50 г — для чая с фасовкой 25 г это
  // означало показ цены за несуществующий вес (см. priceForWeight, которая
  // в этом случае молча откатывалась на minPrice). Показываем пилюли только
  // для реально существующих фасовок этого чая, если они заданы.
  function weightTiersFor(tea) {
    if (isTeaware(tea)) return [0];
    if (tea && Array.isArray(tea.prices) && tea.prices.length) {
      var ws = tea.prices
        .map(function (p) { return p.weightGrams; })
        .filter(function (w) { return typeof w === 'number' && w > 0; });
      ws = ws.filter(function (w, i) { return ws.indexOf(w) === i; }).sort(function (a, b) { return a - b; });
      if (ws.length) return ws;
    }
    return WEIGHTS;
  }

  // state: { weight, qty, tab, fav, added }
  function renderProductMarkup(tea, state) {
    state = state || {};
    var weightTiers = weightTiersFor(tea);
    var weight = state.weight || weightTiers[0];
    var qty = state.qty || 1;
    var tab = state.tab || 'desc';

    var price = priceForWeight(tea, weight);
    var ware = isTeaware(tea);
    var priceHtml = price != null
      ? '<span style="font-size:30px;font-weight:700;">' + formatPrice(price) + ' ₽</span><span style="font-size:14px;color:#9AA192;"> / ' + unitLabel(weight) + '</span>'
      : '<span style="font-size:20px;font-weight:700;color:#9AA192;">цена уточняется</span>';
    // Наличие выбранной фасовки. Купить можно в любом случае.
    var stockNow = stockForWeight(tea, weight);
    var inStock = stockNow > 0;
    priceHtml += '<div class="stock-badge ' + (inStock ? 'in' : 'order') + '">' + (inStock ? 'В наличии' : 'Под заказ') + '</div>';
    var stockNote = !inStock
      ? '<div class="stock-note-line">Сейчас нет на полке — можно заказать: привезём и сообщим срок, когда подтвердим заказ.</div>'
      : (stockNow <= 2 ? '<div class="stock-note-line">Осталось ' + stockNow + ' шт — если возьмёте больше, остальное привезём под заказ.</div>' : '');

    var weightHtml = ware ? '' : weightTiers.map(function (w) {
      return '<div class="pill' + (w === weight ? ' on' : '') + '" data-weight="' + w + '">' + w + ' г</div>';
    }).join('');

    var addLabel = state.added
      ? '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"></path></svg>Добавлено'
      : '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.9"><path d="M6 8h12l-1 12H7L6 8z"></path><path d="M9 8V6a3 3 0 0 1 6 0v2"></path></svg>Добавить в корзину';

    var tabs = ware ? TAB_LABELS.slice(0, 1) : TAB_LABELS;
    if (ware) tab = 'desc';
    var tabsHtml = tabs.map(function (t) {
      return '<div class="tab' + (tab === t.key ? ' on' : '') + '" data-tab="' + t.key + '">' + t.label + '</div>';
    }).join('');

    var descBlock = tab === 'desc'
      ? '<div style="font-size:14.5px;color:#3A4436;line-height:1.6;max-width:820px;margin-top:20px;">' + escapeHtml(tea.description || tea.subtitle || 'Описание уточняется.') + '</div>'
      : '';

    var specRows = [
      ['Регион', fmtList(regionLabel(tea))],
      ['Вкус', fmtList(tea.taste)],
      ['Цвет настоя', fmtList(tea.liquorColor)],
      ['Температура воды', fmtList(tea.waterTemperature)],
      ['Посуда', fmtList(tea.vessels)],
      ['Подходит для', fmtList(tea.situations)],
      ['Противопоказания', fmtList(tea.contraindications)]
    ];
    var specsBlock = tab === 'specs'
      ? '<div style="display:grid;grid-template-columns:1fr 1fr;max-width:820px;margin-top:20px;">' +
        specRows.map(function (r) {
          return '<div class="spec"><span class="muted">' + escapeHtml(r[0]) + '</span><span style="font-weight:600;text-align:right;max-width:280px;">' + escapeHtml(r[1]) + '</span></div>';
        }).join('') + '</div>'
      : '';

    var brewBlock = '';
    if (tab === 'brew') {
      if (tea.brewing && typeof tea.brewing === 'object' && Object.keys(tea.brewing).length) {
        brewBlock = '<div style="max-width:820px;margin-top:20px;display:flex;flex-direction:column;gap:16px;">' +
          Object.keys(tea.brewing).map(function (key) {
            return '<div><div style="font-size:13.5px;font-weight:700;margin-bottom:4px;">' + escapeHtml(BREW_LABELS[key] || key) + '</div>' +
              '<div style="font-size:14px;color:#3A4436;line-height:1.55;">' + escapeHtml(tea.brewing[key]) + '</div></div>';
          }).join('') + '</div>';
      } else {
        brewBlock = '<div class="muted" style="margin-top:20px;font-size:14px;">Инструкция по завариванию уточняется.</div>';
      }
    }

    // «Мнение Города» — авторские заметки мастера/бренда по конкретному чаю.
    // Отдельный, всегда видимый блок (не спрятан по вкладкам), с явной
    // подписью — это отличает его от нейтрального "Описания".
    var cityOpinionBlock = '';
    if (tea.cityOpinion) {
      var opinionParas = String(tea.cityOpinion).split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
      cityOpinionBlock = '<div style="max-width:820px;margin-top:28px;padding:22px 24px;border-radius:16px;background:#F1EBDB;border:1px solid #E3D9C2;">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
        '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#8E6A3E" stroke-width="1.8"><path d="M12 2 15 9l7 1-5 5 1 7-6-3-6 3 1-7-5-5 7-1z"></path></svg>' +
        '<span class="serif" style="font-size:14.5px;font-weight:700;color:#5B4526;">Мнение Города</span></div>' +
        opinionParas.map(function (p) {
          return '<p style="font-size:14px;color:#3A4436;line-height:1.6;margin:0 0 10px;">' + escapeHtml(p) + '</p>';
        }).join('') +
        '</div>';
    }

    return (
      '<div style="display:flex;gap:48px;align-items:flex-start;flex-wrap:wrap;">' +
      '<div style="width:100%;max-width:480px;flex-shrink:0;">' +
      '<div style="width:100%;height:340px;border-radius:20px;box-shadow:0 12px 30px rgba(32,41,31,0.08);' + photoStyleFor(tea) + '"></div>' +
      '</div>' +
      '<div style="flex:1;min-width:280px;">' +
      '<div style="display:inline-block;background:#EFE9DC;border-radius:999px;padding:6px 14px;font-size:12.5px;font-weight:600;color:#5B6357;margin-bottom:14px;">' + escapeHtml(categoryLabel(tea)) + (regionLabel(tea) ? ' · ' + escapeHtml(regionLabel(tea)) : '') + '</div>' +
      '<h1 class="serif" style="font-size:38px;font-weight:700;line-height:1.1;margin:0;">' + escapeHtml(tea.name) + '</h1>' +
      '<div style="font-style:italic;color:#5B6357;font-size:15px;margin-top:12px;line-height:1.5;max-width:480px;">' + escapeHtml(tea.subtitle || '') + '</div>' +
      '<div style="display:flex;align-items:baseline;gap:10px;margin-top:22px;">' + priceHtml + '</div>' + stockNote +
      (weightHtml ? '<div style="display:flex;gap:10px;margin-top:16px;flex-wrap:wrap;">' + weightHtml + '</div>' : '') +
      '<div style="display:flex;align-items:center;gap:16px;margin-top:24px;flex-wrap:wrap;">' +
      '<div style="display:flex;align-items:center;gap:6px;border:1px solid #E3D9C2;border-radius:999px;padding:4px 10px;">' +
      '<button class="qbtn" data-dec>−</button><span style="font-size:15px;font-weight:700;width:20px;text-align:center;display:inline-block;">' + qty + '</span><button class="qbtn" data-inc>+</button>' +
      '</div>' +
      '<button class="cta" id="add-btn" style="flex:1;min-width:200px;text-align:center;padding:15px;border-radius:999px;background:' + (state.added ? '#3F6B34' : '#22392B') + ';color:#fff;font-size:15px;font-weight:700;display:flex;align-items:center;justify-content:center;gap:10px;cursor:pointer;border:none;">' + addLabel + '</button>' +
      '<button class="fav-outline" id="fav-btn" style="width:52px;height:52px;border-radius:999px;border:1.6px solid ' + (state.fav ? '#B5432E' : '#22392B') + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;transition:all .15s;background:#fff;">' +
      '<svg width="20" height="20" viewBox="0 0 24 24" fill="' + (state.fav ? '#B5432E' : 'none') + '" stroke="' + (state.fav ? '#B5432E' : '#22392B') + '" stroke-width="1.8"><path d="M12 20s-7-4.35-9.5-8.5C.7 8 2.7 4.5 6.2 4.5c2 0 3.4 1 4.8 2.7 1.4-1.7 2.8-2.7 4.8-2.7 3.5 0 5.5 3.5 3.7 7C19 15.65 12 20 12 20z"></path></svg>' +
      '</button></div>' +
      '</div></div>' +
      '<div style="padding-top:30px;">' +
      '<div style="display:flex;gap:28px;border-bottom:1px solid #E3D9C2;">' + tabsHtml + '</div>' +
      descBlock + specsBlock + brewBlock +
      '</div>' +
      cityOpinionBlock
    );
  }

  function relatedCardHtml(t, teaHref) {
    var price = formatPrice(t.minPrice);
    var many = Array.isArray(t.prices) && t.prices.length > 1;
    var priceHtml = price != null ? (many ? 'от ' : '') + '<b>' + price + ' ₽</b>' : '<span class="card-noprice">цена уточняется</span>';
    return (
      '<a class="card" href="' + teaHref(t) + '" style="text-decoration:none;color:inherit;">' +
      '<div class="card-img" style="' + photoStyleFor(t) + '"></div>' +
      '<div class="card-name">' + escapeHtml(t.name) + '</div>' +
      '<div class="card-cat">' + escapeHtml(categoryLabel(t)) + '</div>' +
      '<div class="card-bottom"><span class="card-price">' + priceHtml + '</span>' +
      '<button class="cart-btn" data-add="' + escapeHtml(t.id) + '" onclick="event.preventDefault()">' +
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2"><path d="M6 8h12l-1 12H7L6 8z"></path><path d="M9 8V6a3 3 0 0 1 6 0v2"></path></svg>' +
      '</button></div></a>'
    );
  }

  // Красивый адрес страницы чая: /tea/<slug>. Ссылка относительная — на
  // корневых страницах и на страницах чая (там <base href="/">) ведёт в одно место.
  // Без slug (старые данные) — старый адрес, nginx перенаправит его на новый.
  function defaultTeaHref(t) {
    if (t && t.slug) return 'tea/' + encodeURIComponent(t.slug);
    return 'tea-' + encodeURIComponent(t && (t.id || t.teaId)) + '.html';
  }

  function relatedMarkup(related, current, teaHref) {
    teaHref = teaHref || defaultTeaHref;
    // К чаю — чаи того же вида и одна вещь из посуды; к посуде — посуда и чай.
    var rest = related.filter(function (t) { return t.id !== current.id; });
    var same = rest.filter(function (t) { return t.category === current.category; });
    var cross = rest.filter(function (t) { return isTeaware(t) !== isTeaware(current); });
    var others = same.slice(0, 3).concat(cross.slice(0, 1));
    rest.forEach(function (t) { if (others.length < 4 && others.indexOf(t) === -1) others.push(t); });
    if (!others.length) return { html: '', items: [] };
    return { html: others.map(function (t) { return relatedCardHtml(t, teaHref); }).join(''), items: others };
  }

  // Полностью интерактивная страница товара (вес/кол-во/вкладки/избранное/
  // корзина). Работает поверх уже готовой (либо заранее запечённой, либо
  // пустой) разметки — используется и product.html (грузит товар через
  // fetch), и статическими tea-<id>.html (товар уже "вшит" в страницу).
  function mountProduct(tea, related, opts) {
    if (typeof document === 'undefined') return;
    opts = opts || {};
    var root = document.getElementById(opts.rootId || 'product-root');
    var titleEl = document.getElementById(opts.titleElId || 'page-title');
    var crumbEl = document.getElementById(opts.crumbElId || 'crumb-name');
    var relatedGrid = document.getElementById(opts.relatedGridId || 'related-grid');
    var state = { weight: weightTiersFor(tea)[0], qty: 1, tab: 'desc', fav: false, added: false };

    function draw() {
      if (titleEl) titleEl.textContent = tea.name + ' — Чайный город';
      if (crumbEl) crumbEl.textContent = tea.name;
      root.innerHTML = renderProductMarkup(tea, state);

      root.querySelectorAll('[data-weight]').forEach(function (el) {
        el.addEventListener('click', function () { state.weight = Number(el.getAttribute('data-weight')); draw(); });
      });
      root.querySelector('[data-inc]').addEventListener('click', function () { state.qty = Math.min(20, state.qty + 1); draw(); });
      root.querySelector('[data-dec]').addEventListener('click', function () { state.qty = Math.max(1, state.qty - 1); draw(); });
      root.querySelectorAll('[data-tab]').forEach(function (el) {
        el.addEventListener('click', function () { state.tab = el.getAttribute('data-tab'); draw(); });
      });
      var favBtn = document.getElementById('fav-btn');
      if (favBtn) favBtn.addEventListener('click', function () { state.fav = !state.fav; draw(); });
      var addBtn = document.getElementById('add-btn');
      if (addBtn) addBtn.addEventListener('click', function () {
        addToCart(tea, state.weight, state.qty);
        state.added = true;
        draw();
        clearTimeout(global.__addTimer);
        global.__addTimer = setTimeout(function () { state.added = false; draw(); }, 1800);
      });
    }

    draw();

    if (relatedGrid && related && related.length) {
      var res = relatedMarkup(related, tea);
      if (!res.html) {
        relatedGrid.parentElement.style.display = 'none';
      } else {
        relatedGrid.innerHTML = res.html;
        var byId = {}; res.items.forEach(function (t) { byId[t.id] = t; });
        relatedGrid.querySelectorAll('[data-add]').forEach(function (btn) {
          btn.addEventListener('click', function (e) {
            e.preventDefault(); e.stopPropagation();
            var t = byId[btn.getAttribute('data-add')];
            if (t) addToCart(t, null, 1);
          });
        });
      }
    } else if (relatedGrid) {
      relatedGrid.parentElement.style.display = 'none';
    }
  }

  return {
    API_BASE: API_BASE,
    NAV_LINKS: NAV_LINKS,
    CATEGORY_LABELS: CATEGORY_LABELS,
    REGION_LABELS: REGION_LABELS,
    CATEGORY_GRADIENTS: CATEGORY_GRADIENTS,
    escapeHtml: escapeHtml,
    formatPrice: formatPrice,
    gradientFor: gradientFor,
    photoStyleFor: photoStyleFor,
    categoryLabel: categoryLabel,
    regionLabel: regionLabel,
    fmtList: fmtList,
    isTeaware: isTeaware,
    unitLabel: unitLabel,
    priceEntry: priceEntry,
    priceForWeight: priceForWeight,
    stockForWeight: stockForWeight,
    apiGet: apiGet,
    apiPost: apiPost,
    authMe: authMe,
    authLogout: authLogout,
    track: track,
    buyClick: buyClick,
    headerHtml: headerHtml,
    footerHtml: footerHtml,
    mountChrome: mountChrome,
    renderProductMarkup: renderProductMarkup,
    relatedMarkup: relatedMarkup,
    relatedCardHtml: relatedCardHtml,
    defaultTeaHref: defaultTeaHref,
    mountProduct: mountProduct,
    cart: {
      read: readCart,
      write: writeCart,
      count: cartCount,
      add: addToCart,
      changeQty: changeQty,
      remove: removeFromCart,
      updateBadges: updateCartBadges
    }
  };
});
