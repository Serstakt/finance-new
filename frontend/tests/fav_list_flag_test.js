// Интеграционный тест: снятие/установка флажка из fav_-списка («Красный»,
// «Синий»…) должен вызывать POST /api/watchlist/flag.
//
// Раньше setFavorite делал `if (!listId.startsWith('fav_')) setFlagInDb(...)` и
// во fav_-списке запрос не отправлялся вовсе: флажок снимался только локально и
// возвращался при следующей загрузке избранного из БД (loadFlagsFromDb).
// Теперь фронтенд перенаправляет запрос в родительский список (findListWithTicker),
// а бэкенд дополнительно подстраховывает list_id='fav_*' в watchlist_service.set_flag.
//
// Тест берёт РЕАЛЬНЫЙ код setFavorite/findListWithTicker из js/main.js (вырезается
// по маркерам — весь main.js тянет DOM-обвязку страницы) и РЕАЛЬНУЮ сетевую часть
// setFlagInDb из js/state.js через node:vm с заглушкой fetch.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// Вырезает из исходника блок window.<name> = function(...) {...}; до строки '};'
// на нулевом отступе (так объявлены все нужные функции в main.js/state.js).
function extractFn(src, name) {
  const start = src.indexOf(`window.${name} = function`);
  if (start === -1) throw new Error(`Не найден ${name}`);
  const end = src.indexOf('\n};', start);
  if (end === -1) throw new Error(`Не найден конец ${name}`);
  return src.slice(start, end + 3);
}

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'state.js'), 'utf8');

const code = [
  extractFn(stateSrc, 'setFlagInDb'),   // реальный сетевой вызов /api/watchlist/flag
  extractFn(mainSrc, 'findListWithTicker'),
  extractFn(mainSrc, 'setFavorite'),
].join('\n\n');

// ---------- Окружение ----------
const flagRequests = []; // [{url, body}] — все вызовы /api/watchlist/flag

const sandbox = {
  console, setTimeout, clearTimeout, Promise, JSON, Object, Array, String, fetch,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  log: () => {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(`
  window.API_BASE = '';
  window.appState = {
    activeListId: 'fav_red',
    lists: {
      default: { name: 'Основной', tickers: ['SBER', 'GAZP'], activeSymbol: 'SBER', collapsedSections: [] },
      list_2:  { name: 'Второй',   tickers: ['LKOH'],        activeSymbol: '', collapsedSections: [] },
      fav_red: { name: 'Красный',  tickers: ['SBER'],        activeSymbol: '', collapsedSections: [], isFavoriteList: true },
    },
    favorites: { SBER: 'red' },
    notes: {},
  };
  window.FLAG_COLORS = { red: { name: 'Красный', hex: '#ef5350' }, blue: { name: 'Синий', hex: '#2962ff' }, green: { name: 'Зеленый', hex: '#26a69a' } };
  window.favoriteListName = (c) => (window.FLAG_COLORS[c] || { name: c }).name;
  window.getCurrentList = () => appState.lists[appState.activeListId];
  window.saveState = () => {};
  window.populateListSelector = () => {};
  window.updateFavoriteFlagsOnly = () => {};
  window.activePickerSymbol = 'SBER';
  window.fetchWithTimeout = async (url, opts) => {
    if (String(url).includes('/api/watchlist/flag')) {
      flagRequests.push({ url: String(url), body: JSON.parse(opts.body) });
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  };
`, sandbox);
vm.runInContext(code, sandbox);

(async () => {
  // 1) Снятие флажка кликом по флажку внутри fav_-списка «Красный».
  await vm.runInContext(`setFavorite('SBER', null)`, sandbox);
  await new Promise(r => setTimeout(r, 0));
  assert(flagRequests.length === 1, 'При снятии флажка в fav_-списке вызван /api/watchlist/flag');
  const req = flagRequests[0] || {};
  assert(req.body && req.body.list_id === 'default',
    'Запрос ушёл в родительский список (default), где хранится флаг, а не в fav_red');
  assert(req.body && req.body.symbol === 'SBER' && req.body.color === null,
    'В запросе передан символ SBER и color=null (снятие)');
  assert(!sandbox.appState.favorites.SBER, 'Флажок снят локально (appState.favorites)');
  assert(!sandbox.appState.lists.fav_red.tickers.includes('SBER'),
    'SBER удалён из производного fav_red-списка');

  // 2) Установка нового цвета из fav_-списка — тоже должно уйти в БД.
  flagRequests.length = 0;
  await vm.runInContext(`setFavorite('SBER', 'blue')`, sandbox);
  await new Promise(r => setTimeout(r, 0));
  assert(flagRequests.length === 1 && flagRequests[0].body.color === 'blue'
    && flagRequests[0].body.list_id === 'default',
    'При смене цвета из fav_-списка запрос ушёл в родительский список с новым цветом');

  // 3) Обычный список — поведение без изменений: запрос в активный список.
  flagRequests.length = 0;
  vm.runInContext(`appState.activeListId = 'list_2'; appState.favorites['LKOH'] = 'green';`, sandbox);
  await vm.runInContext(`setFavorite('LKOH', null)`, sandbox);
  await new Promise(r => setTimeout(r, 0));
  assert(flagRequests.length === 1 && flagRequests[0].body.list_id === 'list_2',
    'В обычном списке запрос уходит в активный список напрямую');

  // 4) findListWithTicker игнорирует fav_-списки и находит тикер в обычном.
  const found = vm.runInContext(`findListWithTicker('GAZP')`, sandbox);
  assert(found === 'default', 'findListWithTicker находит обычный список с тикером');
  const missing = vm.runInContext(`findListWithTicker('ROSN')`, sandbox);
  assert(missing === null, 'findListWithTicker возвращает null для отсутствующего тикера');

  console.log(failures ? `\n${failures} TEST(S) FAILED` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
