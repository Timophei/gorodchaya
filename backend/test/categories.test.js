// Категории: сущность с описанием, картинкой, SEO и активностью; чай — в нескольких.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startServer, sampleTea } = require('./helpers');

test('Категории', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  const tea = (over) => s.api('POST', '/teas', { key: true, body: sampleTea(over) });
  await tea();
  await tea({ id: 'shupuer', name: 'Шу Пуэр', category: 'puer', categoryLabel: 'Пуэр' });

  await t.test('из старого списка создаются категории по умолчанию', async () => {
    const r = await s.api('GET', '/categories');
    assert.deepEqual(r.body.slice(0, 4).map((c) => c.id), ['green', 'black', 'oolong', 'puer']);
    const green = r.body.find((c) => c.id === 'green');
    assert.equal(green.name, 'Зелёный чай');
    assert.equal(green.count, 1);
  });

  let ng;
  await t.test('новая категория-подборка с описанием и SEO, чаи из разных видов', async () => {
    const r = await s.api('POST', '/admin/categories', { key: true, body: {
      name: 'Коллекция НГ 2027', description: 'Чаи к новогоднему столу',
      seoTitle: 'Новогодние чаи 2027', seoDescription: 'Подборка к празднику', seoText: '<p>Текст</p>',
      teaIds: ['longjing', 'shupuer'],
    } });
    assert.equal(r.status, 201);
    ng = r.body;
    assert.equal(ng.id, 'kollekciya-ng-2027');
    assert.equal(ng.count, 2);
    const inNg = await s.api('GET', `/teas?category=${ng.id}`);
    assert.deepEqual(inNg.body.map((x) => x.id).sort(), ['longjing', 'shupuer']);
    const green = await s.api('GET', '/teas?category=green');
    assert.deepEqual(green.body.map((x) => x.id), ['longjing'], 'и в «Зелёном» Лун Цзин остался');
  });

  await t.test('чай в нескольких категориях; основная всегда первая и в списке', async () => {
    const r = await s.api('GET', '/teas/longjing');
    assert.equal(r.body.category, 'green');
    assert.deepEqual(r.body.categories, ['green', ng.id]);
  });

  await t.test('сохранение чая без поля categories не сбрасывает его категории', async () => {
    await tea({ name: 'Лун Цзин (новое имя)' });
    assert.deepEqual((await s.api('GET', '/teas/longjing')).body.categories, ['green', ng.id]);
  });

  await t.test('переименование категории меняет подпись у её чаёв', async () => {
    await s.api('POST', '/admin/categories', { key: true, body: { id: 'green', name: 'Зелёные' } });
    assert.equal((await s.api('GET', '/teas/longjing')).body.categoryLabel, 'Зелёные');
  });

  await t.test('выключенная категория пропадает с витрины, чаи остаются', async () => {
    await s.api('POST', '/admin/categories', { key: true, body: { id: ng.id, name: ng.name, active: false } });
    const pub = await s.api('GET', '/categories');
    assert.ok(!pub.body.some((c) => c.id === ng.id));
    assert.equal((await s.api('GET', `/categories/${ng.id}`)).status, 404);
    assert.ok((await s.api('GET', '/teas')).body.some((x) => x.id === 'longjing'));
    const adm = await s.api('GET', '/categories', { key: true });
    assert.ok(adm.body.some((c) => c.id === ng.id && c.active === false));
    await s.api('POST', '/admin/categories', { key: true, body: { id: ng.id, name: ng.name, active: true } });
    assert.ok((await s.api('GET', '/categories')).body.some((c) => c.id === ng.id));
  });

  await t.test('убрать чай из подборки можно, из основной категории — нет', async () => {
    const r = await s.api('POST', '/admin/categories', { key: true, body: { id: 'green', name: 'Зелёные', teaIds: [] } });
    assert.match(r.body.warning, /основная/);
    assert.deepEqual((await s.api('GET', '/teas?category=green')).body.map((x) => x.id), ['longjing']);
    await s.api('POST', '/admin/categories', { key: true, body: { id: ng.id, name: ng.name, teaIds: ['shupuer'] } });
    assert.deepEqual((await s.api('GET', '/teas/longjing')).body.categories, ['green']);
  });

  await t.test('удалить основную категорию нельзя, подборку — можно (снимается у чаёв)', async () => {
    const r = await s.api('DELETE', '/admin/categories/puer', { key: true });
    assert.equal(r.status, 409);
    assert.match(r.body.message, /Шу Пуэр/);
    assert.equal((await s.api('DELETE', `/admin/categories/${ng.id}`, { key: true })).status, 204);
    assert.deepEqual((await s.api('GET', '/teas/shupuer')).body.categories, ['puer']);
  });

  await t.test('чай с несуществующей категорией не сохраняется', async () => {
    assert.equal((await tea({ id: 'x1', name: 'X', category: 'nope' })).status, 400);
  });

  await t.test('кривой адрес категории отклоняется, без ключа — 401', async () => {
    assert.equal((await s.api('POST', '/admin/categories', { key: true, body: { id: 'Кривой адрес', name: 'X' } })).status, 400);
    assert.equal((await s.api('POST', '/admin/categories', { body: { name: 'X' } })).status, 401);
  });

  await t.test('картинка-превью категории сохраняется в папку витрины', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5f6a6b80000000049454e44ae426082', 'hex');
    const r = await s.api('POST', '/admin/categories/green/photo', { key: true, raw: 'image/png', body: png });
    assert.equal(r.status, 200);
    assert.match(r.body.imageUrl, /^assets\/categories\/green-.*\.png$/);
    assert.ok(fs.existsSync(path.join(s.dir, 'site', r.body.imageUrl)));
    assert.equal((await s.api('POST', '/admin/categories/green/photo', { key: true, raw: 'image/png', body: Buffer.from('not image') })).status, 400);
  });
});

test('Миграция старого каталога: categories появляется у каждого чая', async (t) => {
  const { startServer: start } = require('./helpers');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mig-'));
  const storePath = path.join(dir, 'store.json');
  fs.writeFileSync(storePath, JSON.stringify({ teas: {
    a: { id: 'a', name: 'А', category: 'oolong', categoryLabel: 'Улун', prices: [] },
    b: { id: 'b', name: 'Б', category: 'herbal', categoryLabel: 'Травы', prices: [] },
  }, removed: [] }));
  const s = await start({ STORE_PATH: storePath });
  t.after(() => s.stop());
  const a = (await s.api('GET', '/teas/a')).body;
  assert.deepEqual(a.categories, ['oolong']);
  const cats = (await s.api('GET', '/categories')).body;
  assert.equal(cats.find((c) => c.id === 'herbal').name, 'Травы', 'подпись старых данных сохранилась');
  assert.equal(JSON.parse(fs.readFileSync(storePath, 'utf8')).teas.b.categories[0], 'herbal');
});
