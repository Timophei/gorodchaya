// Поднимает бэкенд на свободном порту с пустой временной папкой данных.
// Серверные пути (сайт, генератор, база мастера) уводятся во временную
// папку — на машине разработчика их нет, и бэкенд эти шаги просто пропустит.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const API_KEY = 'test-key';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

async function startServer(extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-'));
  const data = path.join(dir, 'data');
  fs.mkdirSync(data);
  const port = await freePort();
  const env = {
    ...process.env,
    PORT: String(port), API_KEY, SESSION_SECRET: 'test-secret',
    TELEGRAM_BOT_TOKEN: '',
    DATA_DIR: data,
    STORE_PATH: path.join(data, 'store.json'),
    ORDERS_STORE_PATH: path.join(data, 'orders.json'),
    USERS_STORE_PATH: path.join(data, 'users.json'),
    VISITORS_STORE_PATH: path.join(data, 'visitors.json'),
    SITE_DIR: path.join(dir, 'site'),
    GENERATOR_PATH: path.join(dir, 'no-generator.mjs'),
    CONSULTANT_KB_PATH: path.join(dir, 'kb', 'teas.json'),
    NOTIFY_DISABLED: '1', // в тестах бот никуда не ходит, только пишет в outbox
    ...extraEnv,
  };
  const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i += 1) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch { /* ещё стартует */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  const api = async (method, p, { body, cookie, key, raw } = {}) => {
    const headers = { Accept: 'application/json' };
    if (body !== undefined && !raw) headers['Content-Type'] = 'application/json';
    if (raw) headers['Content-Type'] = raw;
    if (cookie) headers.Cookie = cookie;
    if (key) headers['x-api-key'] = API_KEY;
    const r = await fetch(`${base}/api${p}`, { method, headers, body: body === undefined ? undefined : (raw ? body : JSON.stringify(body)) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* не JSON */ }
    return { status: r.status, body: json, text, setCookie: r.headers.get('set-cookie') };
  };
  return {
    base, api, dir, data, port, log: () => log,
    stop: () => new Promise((resolve) => { proc.once('exit', resolve); proc.kill(); }),
  };
}

// Регистрация по почте → cookie сессии (плюс метка браузера, если передана).
async function register(api, email, vid) {
  const cookie = vid ? `cg_vid=${vid}` : undefined;
  const r = await api('POST', '/auth/register', { body: { email, password: 'secret123', name: 'Тест' }, cookie });
  const session = (r.setCookie || '').split(';')[0];
  return [session, vid ? `cg_vid=${vid}` : null].filter(Boolean).join('; ');
}

const sampleTea = (over = {}) => ({
  id: 'longjing', name: 'Лун Цзин', category: 'green', categoryLabel: 'Зелёный чай',
  prices: [{ weightGrams: 50, price: 590, stock: 5 }], ...over,
});

const sampleOrder = (over = {}) => ({
  items: [{ teaId: 'longjing', name: 'Лун Цзин', weightGrams: 50, qty: 1, unitPrice: 590 }],
  subtotal: 590, deliveryPrice: 0, total: 590,
  customer: { name: 'Иван', phone: '+7 900 000-00-01', address: 'Иркутск, ул. Ленина, 1' },
  ...over,
});

module.exports = { startServer, register, sampleTea, sampleOrder, API_KEY };
