// Настройки магазина и бот уведомлений о заказах.
const test = require('node:test');
const assert = require('node:assert');
const { startServer, startFake, waitFor, sampleTea, sampleOrder } = require('./helpers');

const TOKEN = '123456:AAbbCCddEEffGGhhIIjjKKllMMnn';

test('Настройки', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  await t.test('без ключа админки настройки не читаются и не меняются', async () => {
    assert.equal((await s.api('GET', '/admin/settings')).status, 401);
    assert.equal((await s.api('POST', '/admin/settings', { body: { pickup: { address: 'Взлом, 1' } } })).status, 401);
  });

  await t.test('по умолчанию: самовывоз с Чудотворной, 2в; Иркутск 100 ₽', async () => {
    const r = await s.api('GET', '/settings/public');
    assert.equal(r.body.pickup.address, 'Чудотворная, 2в');
    assert.equal(r.body.delivery.city.price, 100);
    assert.equal(r.body.addressSuggest, false);
  });

  await t.test('смена адреса чайной сохраняется и видна витрине', async () => {
    const r = await s.api('POST', '/admin/settings', { key: true, body: { pickup: { address: 'Ленина, 5' } } });
    assert.equal(r.status, 200);
    assert.equal((await s.api('GET', '/settings/public')).body.pickup.address, 'Ленина, 5');
  });

  await t.test('пустой порог «бесплатно от» сохраняется как «всегда платно»', async () => {
    await s.api('POST', '/admin/settings', { key: true, body: { delivery: { city: { freeFrom: null } } } });
    assert.equal((await s.api('GET', '/settings/public')).body.delivery.city.freeFrom, null);
    await s.api('POST', '/admin/settings', { key: true, body: { delivery: { city: { freeFrom: 3000 } } } });
  });

  await t.test('токены не уходят ни витрине, ни в админку — только признак «задан»', async () => {
    await s.api('POST', '/admin/settings', { key: true, body: { dadataToken: 'secret-dadata-token', notifyBotToken: TOKEN } });
    const pub = await s.api('GET', '/settings/public');
    const adm = await s.api('GET', '/admin/settings', { key: true });
    assert.ok(!pub.text.includes('secret-dadata-token') && !pub.text.includes(TOKEN));
    assert.ok(!adm.text.includes('secret-dadata-token') && !adm.text.includes(TOKEN));
    assert.equal(adm.body.dadata.tokenSet, true);
    assert.equal(adm.body.notify.botTokenSet, true);
    assert.equal(pub.body.addressSuggest, true);
  });

  await t.test('пустое поле токена не стирает сохранённый, null — стирает', async () => {
    await s.api('POST', '/admin/settings', { key: true, body: { dadataToken: '' } });
    assert.equal((await s.api('GET', '/admin/settings', { key: true })).body.dadata.tokenSet, true);
    await s.api('POST', '/admin/settings', { key: true, body: { dadataToken: null } });
    assert.equal((await s.api('GET', '/admin/settings', { key: true })).body.dadata.tokenSet, false);
  });

  await t.test('кривой токен бота отклоняется', async () => {
    const r = await s.api('POST', '/admin/settings', { key: true, body: { notifyBotToken: 'не-токен' } });
    assert.equal(r.status, 400);
  });
});

test('Бот уведомлений', async (t) => {
  const tg = await startFake((url) => {
    if (url.endsWith('/getMe')) return { ok: true, result: { username: 'chay_orders_bot', first_name: 'Заказы' } };
    if (url.endsWith('/sendMessage')) return { ok: true, result: {} };
    return { ok: true, result: {} };
  });
  const s = await startServer({ TELEGRAM_API_BASE: tg.base });
  t.after(async () => { await s.stop(); await tg.stop(); });
  await s.api('POST', '/teas', { body: sampleTea({ prices: [{ weightGrams: 50, price: 590, stock: 0 }] }), key: true });
  await s.api('POST', '/admin/settings', { key: true, body: { notifyBotToken: TOKEN } });

  let code;
  await t.test('«Проверить» узнаёт имя бота и даёт ссылку для подписки', async () => {
    const r = await s.api('POST', '/admin/settings/notify/check', { key: true });
    assert.equal(r.status, 200);
    code = (await s.api('GET', '/admin/settings', { key: true })).body.notify.subscribeCode;
    assert.equal(r.body.subscribeLink, `https://t.me/chay_orders_bot?start=${code}`);
  });

  await t.test('/start без кода — не подписывает', async () => {
    tg.updates.push({ update_id: 1, message: { chat: { id: 666, first_name: 'Чужой' }, text: '/start' } });
    await waitFor(() => tg.requests.some((r) => r.path.endsWith('/sendMessage') && r.body.chat_id === 666));
    assert.equal((await s.api('GET', '/admin/settings', { key: true })).body.notify.subscribers.length, 0);
  });

  await t.test('/start с кодом из админки — подписывает', async () => {
    tg.updates.push({ update_id: 2, message: { chat: { id: 42, first_name: 'Тимофей' }, text: `/start ${code}` } });
    const ok = await (async () => {
      for (let i = 0; i < 100; i += 1) {
        const list = (await s.api('GET', '/admin/settings', { key: true })).body.notify.subscribers;
        if (list.length) return list;
        await new Promise((r) => setTimeout(r, 30));
      }
      return [];
    })();
    assert.deepEqual(ok.map((x) => [x.chatId, x.name]), [[42, 'Тимофей']]);
  });

  await t.test('новый заказ приходит подписчику с составом, суммой, «под заказ» и ссылкой', async () => {
    const r = await s.api('POST', '/orders', { body: sampleOrder({ customer: { name: 'Иван', phone: '+79000000001', address: 'Иркутск, Ленина 1', comment: 'после 18' } }) });
    assert.equal(r.status, 201);
    const msg = await waitFor(() => tg.requests.find((x) => x.path.endsWith('/sendMessage') && x.body.chat_id === 42 && /Новый заказ/.test(x.body.text)));
    assert.ok(msg, 'уведомление не пришло');
    for (const part of [`№${r.body.order.number}`, 'Лун Цзин, 50 г × 1', 'под заказ', 'Доставка по городу', 'Иркутск, Ленина 1', '+79000000001', 'после 18', `#order-${r.body.order.id}`]) {
      assert.ok(msg.body.text.includes(part), `в уведомлении нет «${part}»`);
    }
  });

  await t.test('продажа в магазине уведомление не шлёт', async () => {
    const before = tg.requests.filter((x) => x.path.endsWith('/sendMessage')).length;
    await s.api('POST', '/admin/orders/offline', { key: true, body: { items: [{ teaId: 'longjing', weightGrams: 50, qty: 1 }] } });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(tg.requests.filter((x) => x.path.endsWith('/sendMessage')).length, before);
  });

  await t.test('/stop отписывает', async () => {
    tg.updates.push({ update_id: 3, message: { chat: { id: 42 }, text: '/stop' } });
    let list = [1];
    for (let i = 0; i < 100 && list.length; i += 1) {
      list = (await s.api('GET', '/admin/settings', { key: true })).body.notify.subscribers;
      await new Promise((r) => setTimeout(r, 30));
    }
    assert.equal(list.length, 0);
  });
});

test('Бот недоступен — заказ всё равно создаётся', async (t) => {
  const s = await startServer(); // Telegram «в никуда»
  t.after(() => s.stop());
  await s.api('POST', '/teas', { body: sampleTea(), key: true });
  await s.api('POST', '/admin/settings', { key: true, body: { notifyBotToken: TOKEN } });
  const r = await s.api('POST', '/orders', { body: sampleOrder() });
  assert.equal(r.status, 201);
  assert.equal((await s.api('GET', '/orders', { key: true })).body.orders.length, 1);
});
