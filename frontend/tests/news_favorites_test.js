// Интеграционный тест избранного во вкладке «Новости» раздела WATCHLIST.
// Прогоняет РЕАЛЬНЫЙ frontend/js/api.js через node:vm с мини-DOM и проверяет:
//   • карточки новостей рендерятся с флажком-кнопкой слева (⚑ / 🚩);
//   • клик по флажку ставит/снимает избранное оптимистично и отправляет
//     POST /api/news/favorite;
//   • GET /api/news/favorites восстанавливает красные флажки без перезагрузки;
//   • ошибка сети откатывает флажок обратно.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// ---------- Мини-DOM ----------
class Node {
  constructor(tag) {
    this.tagName = (tag || '').toUpperCase();
    this._kids = [];
    this.parentNode = null;
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.textContent = '';
  }
  get children() { return this._kids.filter(k => k.tagName !== '#TEXT'); }
  appendChild(n) { n.parentNode = this; this._kids.push(n); return n; }
  removeChild(n) { this._kids = this._kids.filter(k => k !== n); n.parentNode = null; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  // innerHTML: храним строку и парсим data-link кнопок/карточек для запросов
  set innerHTML(html) {
    this._html = html;
    this._kids = [];
    // вытаскиваем блоки news-item с их data-link — этого достаточно тесту
    const re = /<div class="news-item" data-link="([^"]*)"/g;
    let m;
    while ((m = re.exec(html))) {
      const item = new Node('div');
      item.className = 'news-item';
      item.dataset.link = m[1];
      const btn = new Node('button');
      btn._isFlagBtn = true;
      item.appendChild(btn);
      const a = new Node('a');
      item.appendChild(a);
      this.appendChild(item);
    }
  }
  get innerHTML() { return this._html || ''; }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => {
      for (const k of n._kids) {
        if (sel === '.news-item' && k.className === 'news-item') out.push(k);
        if (sel === 'button' && k._isFlagBtn) out.push(k);
        walk(k);
      }
    };
    walk(this);
    return out;
  }
  closest(cls) {
    let n = this;
    while (n) { if (n.className === cls) return n; n = n.parentNode; }
    return null;
  }
}

const byId = {};
for (const id of ['news-panel', 'news-list', 'notes-list']) byId[id] = new Node('div');

const posts = [
  { title: 'Сбер: МСФО за квартал', publisher: 'Smart-Lab News', time: '01.10.2026 10:00', link: 'https://t.me/newssmartlab/111/' },
  { title: 'Лукойл дивиденды', publisher: 'Smart-Lab News', time: '30.09.2026', link: 'http://t.me/newssmartlab/222' },
];

// ---------- Сеть ----------
const favoritesStore = {}; // link -> {ticker,title}
let failNextFavoritePost = false;
const fetchLog = [];
const fakeFetch = async (url, opts = {}) => {
  fetchLog.push({ url, method: opts.method || 'GET', body: opts.body });
  if (String(url).includes('/api/news/telegram/')) {
    return { ok: true, status: 200, json: async () => ({ symbol: 'MOEX:SBER', news: posts }) };
  }
  if (String(url).includes('/api/news/favorites')) {
    return { ok: true, status: 200, json: async () => ({ favorites: { ...favoritesStore } }) };
  }
  if (String(url).includes('/api/news/favorite')) {
    if (failNextFavoritePost) { failNextFavoritePost = false; return { ok: false, status: 500, json: async () => ({}) }; }
    const p = JSON.parse(opts.body);
    const norm = p.link.replace(/^http:\/\//, 'https://').replace(/\/+$/, '');
    if (p.favorite) favoritesStore[norm] = { ticker: p.ticker, title: p.title };
    else delete favoritesStore[norm];
    return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// ---------- sandbox для api.js ----------
const sandbox = {
  console, setTimeout, clearTimeout, CSS: { escape: (s) => s },
  fetch: fakeFetch,
  AbortController: class { constructor() { this.signal = {}; } abort() {} },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => 'news', setItem: () => {} },
  document: {
    getElementById: (id) => byId[id] || null,
    createElement: (t) => new Node(t),
    querySelectorAll: (sel) => (byId['news-list'].querySelectorAll(sel)),
    head: { appendChild: () => {} },
  },
  location: { protocol: 'http:', port: '8000' },
  getCurrentList: () => ({ activeSymbol: 'MOEX:SBER' }),
  switchBottomTab: () => {},
};
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8'), sandbox);

(async () => {
  await sandbox.window.loadTickerNews('MOEX:SBER', true);
  await new Promise(r => setTimeout(r, 0)); // дождаться loadNewsFavorites

  const items = byId['news-list'].querySelectorAll('.news-item');
  assert(items.length === 2, 'Отрисованы обе новости как .news-item');
  assert(byId['news-list'].innerHTML.includes('data-link="https://t.me/newssmartlab/111"'),
    'Ссылка канонизирована (https, без хвостового слэша) в data-link');
  assert(byId['news-list'].innerHTML.includes('⚑') && !byId['news-list'].innerHTML.includes('🚩'),
    'Изначально флажки серые (⚑), избранного нет');

  // --- Клик по флажку первой новости: ставим избранное
  const firstLink = 'https://t.me/newssmartlab/111';
  const firstItem = items.find(i => i.dataset.link === firstLink);
  const btn = firstItem.children[0];
  btn.closest = (cls) => (btn.parentNode.className === cls ? btn.parentNode : null);
  await sandbox.window.toggleNewsFavorite(encodeURIComponent(firstLink), btn);
  assert(!!sandbox.window.newsFavorites[firstLink], 'Флажок сохранён в newsFavorites');
  assert(favoritesStore[firstLink], 'Избранное ушло на сервер (POST /api/news/favorite)');
  const postCall = fetchLog.find(f => f.method === 'POST' && f.url.includes('/api/news/favorite'));
  const body = JSON.parse(postCall.body);
  assert(body.favorite === true && body.ticker === 'SBER', 'POST содержит favorite=true и тикер SBER');
  assert(byId['news-list'].innerHTML.includes('🚩'), 'После перерисовки новость помечена красным флагом');

  // --- Снятие флажка
  await sandbox.window.toggleNewsFavorite(encodeURIComponent(firstLink), btn);
  assert(!sandbox.window.newsFavorites[firstLink] && !favoritesStore[firstLink],
    'Повторный клик снимает избранное');

  // --- Ошибка сети: откат оптимистичной отметки
  failNextFavoritePost = true;
  await sandbox.window.toggleNewsFavorite(encodeURIComponent(firstLink), btn);
  assert(!sandbox.window.newsFavorites[firstLink],
    'При ошибке сервера флажок откатывается (не остаётся избранным локально)');

  // --- Восстановление из БД: вторая новость избрана на «сервере», лента перерисовывается
  const secondLink = 'https://t.me/newssmartlab/222';
  favoritesStore[secondLink] = { ticker: 'SBER', title: 'Лукойл дивиденды' };
  await sandbox.window.loadTickerNews('MOEX:SBER', true);
  await new Promise(r => setTimeout(r, 0));
  assert(!!sandbox.window.newsFavorites[secondLink], 'loadNewsFavorites подтянул избранное из БД');
  const html2 = byId['news-list'].innerHTML;
  const secondBlock = html2.split('<div class="news-item"').find(b => b.startsWith(' data-link="https://t.me/newssmartlab/222"'));
  assert(secondBlock && secondBlock.includes('🚩'), 'Избранная новость отрисована с красным флажком слева');
  assert(secondBlock.includes("border: 1px solid #ef5350") || secondBlock.includes('#ef5350'),
    'Карточка избранной новости подсвечена красной рамкой');

  console.log(failures ? `\n${failures} TEST(S) FAILED` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
