// Настройка блоков сайта: шапка, чат, витрина, гильдия, подвал; история и откат.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, sampleTea } = require('./helpers');

test('Блоки сайта', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const cfg = async () => (await s.api('GET', '/site-config')).body;
  const save = (block, body) => s.api('POST', `/admin/site-config/${block}`, { key: true, body });
  for (const [id, name, category, featured] of [['longjing', 'Лун Цзин', 'green', true], ['shupuer', 'Шу Пуэр', 'puer', true], ['baimudan', 'Бай Му Дань', 'white', false]]) {
    await s.api('POST', '/teas', { key: true, body: sampleTea({ id, name, category, featured }) });
  }

  await t.test('по умолчанию — как было на сайте', async () => {
    const c = await cfg();
    assert.deepEqual(c.header.menu.map((m) => m.label), ['Чат', 'Каталог', 'Посуда', 'Гильдия', 'О городе']);
    assert.equal(c.chat.greeting, 'Привет, какой чай тебя интересует?');
    assert.deepEqual(c.chat.chips.map((x) => x.label), ['Подобрать чай', 'Как заваривать?', 'Для спокойствия', 'В дорогу']);
    assert.equal(c.showcase.title, 'Популярные чаи');
    assert.equal(c.guild.enabled, true);
  });

  await t.test('без ключа менять нельзя', async () => {
    assert.equal((await s.api('POST', '/admin/site-config/guild', { body: { enabled: false } })).status, 401);
  });

  await t.test('шапка: переименовать, переставить, выключить пункт меню', async () => {
    const menu = (await cfg()).header.menu;
    const reordered = [menu[1], menu[0], { ...menu[2], label: 'Посуда и аксессуары' }, { ...menu[3], enabled: false }, menu[4]];
    const r = await save('header', { logoUrl: null, quote: 'Хороший чай', showQuote: true, menu: reordered });
    assert.equal(r.status, 200);
    const c = (await cfg()).header;
    assert.deepEqual(c.menu.map((m) => m.key), ['catalog', 'chat', 'teaware', 'guild', 'about']);
    assert.equal(c.menu[2].label, 'Посуда и аксессуары');
    assert.equal(c.menu[3].enabled, false);
  });

  await t.test('адрес пункта меню подменить нельзя, неизвестные пункты отбрасываются', async () => {
    const menu = (await cfg()).header.menu.map((m) => ({ ...m, href: 'javascript:alert(1)' }));
    await save('header', { logoUrl: null, quote: '', showQuote: false, menu: [...menu, { key: 'evil', label: 'X', enabled: true }] });
    const c = (await cfg()).header.menu;
    assert.ok(c.every((m) => !m.href.startsWith('javascript')));
    assert.ok(!c.some((m) => m.key === 'evil'));
  });

  await t.test('логотип: загрузка картинки, не-картинка отклоняется', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6a6b80000000049454e44ae426082', 'hex');
    const r = await s.api('POST', '/admin/site-config/logo', { key: true, raw: 'image/png', body: png });
    assert.equal(r.status, 200);
    assert.match(r.body.current.header.logoUrl, /^assets\/uploads\/logo-.*\.png$/);
    assert.ok(fs.existsSync(path.join(s.dir, 'site', r.body.current.header.logoUrl)));
    assert.equal((await s.api('POST', '/admin/site-config/logo', { key: true, raw: 'image/png', body: Buffer.from('<svg onload=alert(1)>') })).status, 400);
    const bad = await save('header', { ...(await cfg()).header, logoUrl: 'https://evil.example/x.png' });
    assert.equal(bad.status, 400);
  });

  await t.test('чат: приветствие и быстрые кнопки', async () => {
    await save('chat', { enabled: true, greeting: 'Здравствуйте!', chips: [{ label: 'Подарок', text: 'Посоветуйте чай в подарок' }, { label: 'Утро', text: '' }], catalogButton: false, catalogButtonLabel: 'В каталог' });
    const c = (await cfg()).chat;
    assert.equal(c.greeting, 'Здравствуйте!');
    assert.deepEqual(c.chips, [{ label: 'Подарок', text: 'Посоветуйте чай в подарок' }, { label: 'Утро', text: '' }]);
    assert.equal(c.catalogButton, false);
    assert.equal((await save('chat', { ...c, greeting: '' })).status, 400, 'пустое приветствие не сохраняется');
  });

  await t.test('чат в карточке товара: по умолчанию включён, настраивается и выключается', async () => {
    const pc = (await cfg()).productChat;
    assert.equal(pc.enabled, true);
    assert.match(pc.greeting, /\{чай\}/);
    const r = await save('productChat', { enabled: false, title: 'Вопрос мастеру', greeting: 'Про «{чай}» — спрашивайте', chips: [{ label: 'Как заварить?', text: '' }] });
    assert.equal(r.status, 200);
    const c = (await cfg()).productChat;
    assert.equal(c.enabled, false);
    assert.equal(c.title, 'Вопрос мастеру');
    const tooMany = Array.from({ length: 7 }, (_, i) => ({ label: `в${i}`, text: '' }));
    assert.equal((await save('productChat', { ...c, chips: tooMany })).status, 400);
    await save('productChat', { ...c, enabled: true });
  });

  const showcase = (over) => save('showcase', { enabled: true, title: 'Витрина', description: '', source: 'featured', categoryId: null, teaIds: [], limit: 4, showAllCard: true, ...over });
  const shown = async () => (await s.api('GET', '/site-config/showcase')).body;

  await t.test('витрина: «популярные» — отмеченные в карточке чая', async () => {
    await showcase({});
    assert.deepEqual((await shown()).teas.map((x) => x.id).sort(), ['longjing', 'shupuer']);
  });

  await t.test('витрина: категория, в т.ч. подборка из чаёв разных видов', async () => {
    await showcase({ source: 'category', categoryId: 'green' });
    assert.deepEqual((await shown()).teas.map((x) => x.id), ['longjing']);
    const ng = (await s.api('POST', '/admin/categories', { key: true, body: { name: 'НГ 2027', teaIds: ['shupuer', 'baimudan'] } })).body;
    await showcase({ source: 'category', categoryId: ng.id });
    const r = await shown();
    assert.deepEqual(r.teas.map((x) => x.id).sort(), ['baimudan', 'shupuer']);
    assert.equal(r.category.name, 'НГ 2027');
    // Категорию выключили — витрина пустая (на сайте скрывается), выбрать её заново нельзя.
    await s.api('POST', '/admin/categories', { key: true, body: { id: ng.id, name: ng.name, active: false } });
    assert.deepEqual((await shown()).teas, []);
    assert.equal((await showcase({ source: 'category', categoryId: ng.id })).status, 400);
  });

  await t.test('витрина: вручную, в заданном порядке, с ограничением количества', async () => {
    await showcase({ source: 'manual', teaIds: ['baimudan', 'longjing', 'shupuer', 'nope'], limit: 2 });
    assert.deepEqual((await shown()).teas.map((x) => x.id), ['baimudan', 'longjing']);
  });

  await t.test('гильдия и подвал выключаются', async () => {
    await save('guild', { enabled: false });
    assert.equal((await cfg()).guild.enabled, false);
    const f = (await cfg()).footer;
    const r = await save('footer', { ...f, contacts: { ...f.contacts, mapUrl: 'javascript:alert(1)' } });
    assert.equal(r.status, 400, 'ссылка на карту — только http(s)');
    await save('footer', { ...f, contacts: { ...f.contacts, phone: '+7 (3952) 00-00-00' }, socials: { telegram: '@gorodchaya', vk: '', whatsapp: '' } });
    assert.equal((await cfg()).footer.contacts.phone, '+7 (3952) 00-00-00');
  });

  await t.test('история и откат: вернуть заголовок витрины', async () => {
    await showcase({ title: 'Новый заголовок' });
    const adm = (await s.api('GET', '/admin/site-config', { key: true })).body;
    assert.equal(adm.current.showcase.title, 'Новый заголовок');
    const prev = adm.history[0];
    assert.match(prev.label, /Первая витрина/);
    const r = await s.api('POST', `/admin/site-config/rollback/${prev.id}`, { key: true });
    assert.equal(r.status, 200);
    assert.equal((await cfg()).showcase.title, 'Витрина');
    // Сам откат тоже можно откатить.
    const again = (await s.api('GET', '/admin/site-config', { key: true })).body.history[0];
    assert.equal(again.label, 'До отката');
    await s.api('POST', `/admin/site-config/rollback/${again.id}`, { key: true });
    assert.equal((await cfg()).showcase.title, 'Новый заголовок');
  });

  await t.test('настройки переживают перезапуск', async () => {
    const before = await cfg();
    await s.stop();
    const s2 = await startServer({ DATA_DIR: s.data, STORE_PATH: path.join(s.data, 'store.json') });
    try {
      assert.deepEqual((await s2.api('GET', '/site-config')).body, before);
    } finally { await s2.stop(); }
  });
});

test('Битый файл настроек блоков — сайт получает умолчания', async (t) => {
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bl-'));
  fs.writeFileSync(path.join(dir, 'site-blocks.json'), '{не json');
  const s = await startServer({ BLOCKS_STORE_PATH: path.join(dir, 'site-blocks.json') });
  t.after(() => s.stop());
  const c = (await s.api('GET', '/site-config')).body;
  assert.equal(c.showcase.title, 'Популярные чаи');
});
