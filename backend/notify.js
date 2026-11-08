// Бот уведомлений о заказах — отдельный от бота входа через Telegram.
//
// Как подключиться: в админке → «Настройки» вставить токен бота от
// @BotFather, нажать «Проверить», открыть на телефоне ссылку
// t.me/<бот>?start=<код> и нажать «Старт». Бот запоминает этот чат и
// присылает туда каждый новый заказ с сайта. Без кода из админки бот
// никого не подписывает — иначе любой, кто нашёл бота, получал бы
// телефоны и адреса покупателей.
//
// Сообщения бот забирает сам (long polling getUpdates) — вебхук и
// открытый наружу адрес не нужны. Ошибки Telegram только пишутся в лог:
// заказ из-за уведомления никогда не падает.
const settings = require('./settingsStore');

const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const ADMIN_URL = process.env.ADMIN_URL || 'https://gorodchaya.ru/admin/';

async function call(token, method, body) {
  const r = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 40000 : 10000),
  });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || `Telegram ${r.status}`);
  return data.result;
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const rub = (n) => `${Number(n || 0).toLocaleString('ru-RU')} ₽`;

const DELIVERY_LABELS = { pickup: 'Самовывоз', city: 'Доставка по городу', russia: 'Доставка по России' };

function orderText(o) {
  const c = o.customer || {};
  const lines = [`<b>Новый заказ №${esc(o.number)}</b> · ${rub(o.total)}${o.deliveryPriceKnown === false ? ' + доставка ТК' : ''}`];
  if (o.hasPreorder) lines.push('⚠️ Есть позиции под заказ');
  lines.push('');
  for (const it of o.items || []) {
    const pre = it.preorderQty ? ` — <i>под заказ${it.preorderQty < it.qty ? ` ${it.preorderQty}` : ''}</i>` : '';
    lines.push(`• ${esc(it.name)}${it.weightGrams ? `, ${it.weightGrams} г` : ''} × ${it.qty} — ${rub(it.unitPrice * it.qty)}${pre}`);
  }
  lines.push('');
  const how = DELIVERY_LABELS[o.deliveryMethod] || 'Доставка';
  lines.push(`<b>${how}</b>${o.deliveryMethod === 'pickup' ? '' : `: ${esc(c.address)}`}`);
  if (o.deliveryMethod === 'pickup' && c.address) lines.push(esc(c.address));
  lines.push(`${esc(c.name)} · ${esc(c.phone)}`);
  if (c.comment) lines.push(`💬 ${esc(c.comment)}`);
  lines.push('', `<a href="${esc(ADMIN_URL)}?tab=orders#order-${esc(o.id)}">Открыть в админке</a>`);
  return lines.join('\n');
}

async function sendToAll(text) {
  const n = settings.get().notify;
  if (!n.botToken || !n.subscribers.length) return { sent: 0, failed: 0 };
  let sent = 0; let failed = 0;
  for (const sub of n.subscribers) {
    try {
      await call(n.botToken, 'sendMessage', { chat_id: sub.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
      sent += 1;
    } catch (e) {
      failed += 1;
      console.error(`Уведомление в чат ${sub.chatId} не ушло: ${e.message}`);
    }
  }
  return { sent, failed };
}

function notifyNewOrder(order) {
  sendToAll(orderText(order)).catch((e) => console.error('Уведомление о заказе:', e.message));
}

// Проверка токена из админки: имя бота → ссылка для подписки.
async function checkBot() {
  const n = settings.get().notify;
  if (!n.botToken) throw new Error('Токен бота не задан');
  const me = await call(n.botToken, 'getMe');
  settings.update({ notify: { botUsername: me.username || '' } });
  return { username: me.username, name: me.first_name };
}

// --- приём сообщений боту: /start <код>, /stop ---
let pollToken = null; // токен, под который сейчас крутится цикл
let offset = 0;

async function handleUpdate(u) {
  const m = u.message;
  if (!m || !m.chat || typeof m.text !== 'string') return;
  const n = settings.get().notify;
  const chatId = m.chat.id;
  const reply = (text) => call(n.botToken, 'sendMessage', { chat_id: chatId, text }).catch(() => {});
  const [cmd, arg] = m.text.trim().split(/\s+/);
  if (cmd === '/start') {
    if (arg && arg === n.subscribeCode) {
      if (!n.subscribers.some((s) => s.chatId === chatId)) {
        const name = [m.chat.first_name, m.chat.last_name].filter(Boolean).join(' ') || m.chat.title || m.chat.username || String(chatId);
        settings.update({ notify: { subscribers: [...n.subscribers, { chatId, name, username: m.chat.username || null, at: new Date().toISOString() }] } });
      }
      await reply('Готово: сюда будут приходить новые заказы «Чайного города». Отключиться — /stop');
    } else {
      await reply('Этот бот присылает заказы сотрудникам «Чайного города». Подключиться можно только по ссылке из админки.');
    }
  } else if (cmd === '/stop') {
    settings.update({ notify: { subscribers: n.subscribers.filter((s) => s.chatId !== chatId) } });
    await reply('Уведомления отключены.');
  }
}

async function pollLoop(token) {
  while (pollToken === token) {
    try {
      const updates = await call(token, 'getUpdates', { offset, timeout: 25, allowed_updates: ['message'] });
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        await handleUpdate(u);
      }
    } catch (e) {
      if (pollToken !== token) break;
      console.error('Бот уведомлений, getUpdates:', e.message);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

// Вызывается при старте и после смены токена в настройках.
function restartPolling() {
  const token = settings.get().notify.botToken || null;
  if (token === pollToken) return;
  pollToken = token;
  offset = 0;
  if (token) pollLoop(token);
}

module.exports = { notifyNewOrder, sendToAll, checkBot, restartPolling, orderText };
