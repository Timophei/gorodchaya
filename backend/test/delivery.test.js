// Способ получения заказа: самовывоз, по городу, по России; подсказки адреса.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, startFake, sampleTea, sampleOrder } = require('./helpers');

test('Доставка и самовывоз', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.api('POST', '/teas', { body: sampleTea(), key: true });
  const order = async (over) => s.api('POST', '/orders', { body: sampleOrder(over) });

  await t.test('самовывоз: адрес не нужен, подставляется адрес чайной, доставка 0 ₽', async () => {
    const r = await order({ deliveryMethod: 'pickup', customer: { name: 'Аня', phone: '+79000000002' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.order.customer.address, 'Иркутск, Чудотворная, 2в');
    assert.equal(r.body.order.deliveryPrice, 0);
    assert.equal(r.body.order.total, 590);
  });

  await t.test('по городу: 100 ₽, сумму считает сервер, а не браузер', async () => {
    const r = await order({ deliveryPrice: 0, total: 1 });
    assert.equal(r.body.order.deliveryPrice, 100);
    assert.equal(r.body.order.total, 690);
  });

  await t.test('по городу от порога — бесплатно', async () => {
    const r = await order({ subtotal: 3000, items: [{ teaId: 'longjing', name: 'Лун Цзин', weightGrams: 50, qty: 5, unitPrice: 600 }] });
    assert.equal(r.body.order.deliveryPrice, 0);
  });

  await t.test('по России: цена доставки не известна, отмечено для менеджера', async () => {
    const r = await order({ deliveryMethod: 'russia', customer: { name: 'Петр', phone: '+79000000003', address: 'Москва, Тверская, 1' } });
    assert.equal(r.body.order.deliveryPriceKnown, false);
    assert.equal(r.body.order.total, 590);
  });

  await t.test('доставка без адреса — 400', async () => {
    const r = await order({ customer: { name: 'Петр', phone: '+79000000003', address: '' } });
    assert.equal(r.status, 400);
  });

  await t.test('старая корзина без способа — как доставка по городу', async () => {
    const body = sampleOrder(); delete body.deliveryMethod;
    const r = await s.api('POST', '/orders', { body });
    assert.equal(r.body.order.deliveryMethod, 'city');
  });

  await t.test('выключенный способ не принимается', async () => {
    await s.api('POST', '/admin/settings', { key: true, body: { delivery: { russia: { enabled: false } } } });
    const r = await order({ deliveryMethod: 'russia', customer: { name: 'Петр', phone: '+79000000003', address: 'Москва, Тверская, 1' } });
    assert.equal(r.status, 400);
  });
});

test('Подсказки адреса', async (t) => {
  const dd = await startFake((_url, body) => ({ suggestions: [{ value: `г Иркутск, ул ${body.query}`, data: { city: 'Иркутск' } }] }));
  const s = await startServer({ DADATA_API_BASE: dd.base });
  t.after(async () => { await s.stop(); await dd.stop(); });

  await t.test('без ключа DaData — пустой список, без ошибки', async () => {
    const r = await s.api('GET', '/address/suggest?q=Ленина');
    assert.deepEqual(r.body.suggestions, []);
    assert.equal(dd.requests.length, 0);
  });

  await t.test('с ключом — подсказки, ключ уходит только в DaData', async () => {
    await s.api('POST', '/admin/settings', { key: true, body: { dadataToken: 'dd-token' } });
    const r = await s.api('GET', '/address/suggest?q=Ленина&method=city');
    assert.equal(r.body.suggestions[0].value, 'г Иркутск, ул Ленина');
    assert.equal(dd.requests[0].headers.authorization, 'Token dd-token');
    assert.deepEqual(dd.requests[0].body.locations_boost, [{ city: 'Иркутск' }]);
    assert.ok(!r.text.includes('dd-token'));
  });

  await t.test('короткий запрос в DaData не уходит', async () => {
    const n = dd.requests.length;
    await s.api('GET', '/address/suggest?q=Ле');
    assert.equal(dd.requests.length, n);
  });
});

test('DaData недоступна — пустые подсказки, адрес вводится руками', async (t) => {
  const s = await startServer({ DADATA_API_BASE: 'http://127.0.0.1:9' });
  t.after(() => s.stop());
  await s.api('POST', '/admin/settings', { key: true, body: { dadataToken: 'dd-token' } });
  const r = await s.api('GET', '/address/suggest?q=Ленина');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.suggestions, []);
});
