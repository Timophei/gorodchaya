// «Мои заказы» в личном кабинете видят то же, что админка в карточке покупателя.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, register, sampleTea, sampleOrder } = require('./helpers');

test('Мои заказы', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());
  await s.api('POST', '/teas', { body: sampleTea(), key: true });

  await t.test('заказ, оформленный гостем до входа в том же браузере, виден после входа', async () => {
    const vid = 'browserAAAA1111';
    const guest = await s.api('POST', '/orders', { body: sampleOrder(), cookie: `cg_vid=${vid}` });
    assert.equal(guest.status, 201);
    const cookie = await register(s.api, 'a@test.ru', vid);
    const mine = await s.api('GET', '/orders/mine', { cookie });
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body.orders.map((o) => o.id), [guest.body.order.id]);
    assert.equal(mine.body.orders[0].visitorId, undefined, 'служебные поля не уходят покупателю');
  });

  await t.test('завершённые и отменённые заказы тоже приходят', async () => {
    const cookie = await register(s.api, 'b@test.ru', 'browserBBBB2222');
    const ids = [];
    for (const status of ['done', 'cancelled', 'shipped']) {
      const o = await s.api('POST', '/orders', { body: sampleOrder(), cookie });
      await s.api('POST', `/orders/${o.body.order.id}/status`, { body: { status }, key: true });
      ids.push(o.body.order.id);
    }
    const mine = await s.api('GET', '/orders/mine', { cookie });
    assert.deepEqual(new Set(mine.body.orders.map((o) => o.status)), new Set(['done', 'cancelled', 'shipped']));
  });

  await t.test('продажа в магазине с тем же телефоном попадает к покупателю', async () => {
    const cookie = await register(s.api, 'c@test.ru', 'browserCCCC3333');
    await s.api('POST', '/orders', { body: sampleOrder({ customer: { name: 'Оля', phone: '8 (900) 111-22-33', address: 'Иркутск, Ленина 2' } }), cookie });
    const sale = await s.api('POST', '/admin/orders/offline', { key: true, body: { items: [{ teaId: 'longjing', weightGrams: 50, qty: 1 }], customer: { phone: '+79001112233' } } });
    assert.equal(sale.status, 201);
    const mine = await s.api('GET', '/orders/mine', { cookie });
    assert.ok(mine.body.orders.some((o) => o.id === sale.body.order.id));
    assert.equal(mine.body.orders.find((o) => o.id === sale.body.order.id).seller, undefined);
  });

  await t.test('чужие заказы не видны', async () => {
    const cookie = await register(s.api, 'd@test.ru', 'browserDDDD4444');
    const mine = await s.api('GET', '/orders/mine', { cookie });
    assert.deepEqual(mine.body.orders, []);
  });

  await t.test('без входа — 401', async () => {
    assert.equal((await s.api('GET', '/orders/mine')).status, 401);
  });
});
