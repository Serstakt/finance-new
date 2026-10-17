// Интеграционный тест защиты от гонки в syncListWithDb (state.js).
// Сценарий: пользователь быстро кликает таб A -> B, ответ fetch по A приходит
// ПОСЛЕ ответа по B. Без «запрос-серийного номера» медленный ответ A
// перезаписал бы состояние и вызвал render() поверх активного списка B.
// Прогоняет РЕАЛЬНЫЙ state.js через node:vm с управляемыми заглушками fetch.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// ---------- Заглушки окружения ----------
const dbData = {          // что «лежит в БД» для каждого списка
  A: { symbols: ['SBER', 'GAZP'], name: 'Список A', active_symbol: 'SBER', items: [] },
  B: { symbols: ['LKOH'], name: 'Список B', active_symbol: 'LKOH', items: [] },
};
const pending = {};          // listId -> очередь функций-резолверов (управляемые «медленные» ответы)
const logLines = [];
let renderCalls = 0;

const sandbox = {
  console, setTimeout, clearTimeout, Promise, Map, Set, JSON, Math, Object, Array,
  String, Number, Error, RegExp, encodeURIComponent,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: { getElementById: () => null, querySelectorAll: () => [] },
  API_BASE: 'http://test',
  fetch: async () => ({ ok: false, status: 500 }),
  log: (msg, level) => logLines.push(`${level}: ${msg}`),
  render: () => { renderCalls++; },
  populateListSelector: () => {},
  rebuildFavoriteLists: () => {},
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

// Управляемый fetchWithTimeout: GET /api/watchlist/{id} резолвится только по
// явной команде из теста (имитация «медленного» ответа сервера).
vm.runInContext(`
window.fetchWithTimeout = function(url, options = {}, timeoutMs) {
  const m = String(url).match(/\\/api\\/watchlist\\/([^?]+)$/);
  if (!m || options.method) {
    // repair и прочие POST — мгновенный успех
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  }
  const listId = decodeURIComponent(m[1]);
  return new Promise((resolve) => {
    window.__pending[listId] = window.__pending[listId] || [];
    window.__pending[listId].push((bodyOverride) => resolve(
      bodyOverride || { ok: true, status: 200, json: async () => window.__dbData[listId] }
    ));
  });
};
`, sandbox);
sandbox.__dbData = dbData;
sandbox.__pending = pending;

vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'state.js'), 'utf8'), sandbox);

(async () => {
  // локальное состояние: оба списка существуют, активен A
  sandbox.appState.lists = {
    A: { name: 'Список A', tickers: ['OLD-A'], activeSymbol: 'OLD-A', collapsedSections: [] },
    B: { name: 'Список B', tickers: ['OLD-B'], activeSymbol: 'OLD-B', collapsedSections: [] },
  };
  sandbox.appState.activeListId = 'A';

  // --- Шаг 1: клик по табу A -> syncListWithDb('A') ушёл, ответа ещё нет
  const pA = sandbox.syncListWithDb('A');

  // --- Шаг 2: быстрый клик по табу B: список стал активен, его запрос ушёл
  sandbox.appState.activeListId = 'B';
  const pB = sandbox.syncListWithDb('B');

  // --- Шаг 3: Б отвечает первым — данные B применяются, рисуется B
  pending.B.shift()();
  const okB = await pB;
  assert(okB === true, 'Ответ B применён (syncListWithDb вернул true)');
  assert(JSON.stringify(sandbox.appState.lists.B.tickers) === JSON.stringify(['LKOH']), 'Список B получил свои тикеры из БД');
  assert(renderCalls === 1, 'render() вызван ровно один раз (ответ активного B)');

  // --- Шаг 4: МЕДЛЕННЫЙ ответ A доходит уже при активном табе B.
  // Данные A легальны для своего списка (самый свежий запрос по A) — они
  // применяются в appState.lists.A, но UI (render) тронуты быть не должны:
  // на экране список B, и медленный ответ A не имеет права его перерисовать.
  pending.A.shift()();
  const okA = await pA;
  assert(okA === true, 'Ответ A применён к своему списку в appState');
  assert(JSON.stringify(sandbox.appState.lists.A.tickers) === JSON.stringify(['SBER', 'GAZP']), 'Данные A записаны в свой список');
  assert(renderCalls === 1, 'Медленный ответ A НЕ вызвал render() поверх активного списка B');
  assert(JSON.stringify(sandbox.appState.lists.B.tickers) === JSON.stringify(['LKOH']), 'Состав B не изменился из-за ответа A');

  // --- Шаг 5: повторные быстрые клики A -> B -> A при висящем первом запросе A
  pending.A = []; pending.B = [];
  sandbox.appState.activeListId = 'A';
  sandbox.appState.lists.A.tickers = ['OLD-A'];
  renderCalls = 0;
  const pA1 = sandbox.syncListWithDb('A');   // serial N
  const pB1 = sandbox.syncListWithDb('B');   // serial N+1
  const pA2 = sandbox.syncListWithDb('A');   // serial N+2 (самый свежий по A)
  // «БД» меняется между запросами: устаревший ответ содержит другие данные
  dbData.A = { symbols: ['STALE'], name: 'Список A', active_symbol: 'STALE', items: [] };
  pending.A.shift()();                      // первый (устаревший) ответ A приходит раньше второго
  const okA1 = await pA1;
  assert(okA1 === false, 'Устаревший дубль запроса A отброшен серийным номером (вернул false)');
  assert(JSON.stringify(sandbox.appState.lists.A.tickers) === JSON.stringify(['OLD-A']), 'Устаревший ответ не перезаписал состав A');
  assert(renderCalls === 0, 'Отброшенный ответ не тронул UI');
  assert(logLines.some(l => l.includes('устарел')), 'В логе отмечен отброшенный устаревший ответ (serial check)');
  dbData.A = { symbols: ['SBER', 'GAZP'], name: 'Список A', active_symbol: 'SBER', items: [] };
  pending.B.shift()();
  pending.A.shift()();
  const [okB1, okA2] = await Promise.all([pB1, pA2]);
  assert(okB1 === true && okA2 === true, 'Самые свежие ответы обоих списков применены');
  assert(JSON.stringify(sandbox.appState.lists.A.tickers) === JSON.stringify(['SBER', 'GAZP']), 'Актуальный ответ A применился');

  // --- Шаг 6: сверка list_id в теле ответа (страховка от чужих данных):
  // даже самый свежий запрос отбрасывается, если сервер вернул другой список
  sandbox.appState.activeListId = 'A';
  sandbox.appState.lists.A.tickers = ['OLD-A'];
  renderCalls = 0;
  pending.A = [];
  const pC = sandbox.syncListWithDb('A');
  const origJson = dbData.A;
  // резолвим самый свежий ответ A телом с чужим list_id (страховочная проверка)
  pending.A.shift()({ ok: true, status: 200, json: async () => ({ ...origJson, list_id: 'HACKED' }) });
  const okC = await pC;
  assert(okC === false, 'Ответ с чужим list_id отклонён');
  assert(JSON.stringify(sandbox.appState.lists.A.tickers) === JSON.stringify(['OLD-A']), 'Чужой ответ не изменил состав списка');
  assert(renderCalls === 0, 'Чужой ответ не вызвал render()');

  // --- Шаг 7: нормальный возврат на таб A — данные подтягиваются и рисуются
  renderCalls = 0;
  pending.A = [];
  const pA3 = sandbox.syncListWithDb('A');
  pending.A.shift()();
  const okA3 = await pA3;
  assert(okA3 === true, 'Свежий запрос активного списка применён');
  assert(JSON.stringify(sandbox.appState.lists.A.tickers) === JSON.stringify(['SBER', 'GAZP']), 'Список A получил актуальные тикеры');
  assert(renderCalls === 1, 'render() вызван для активного списка A');

  console.log(failures ? `\n${failures} TEST(S) FAILED` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error('Ошибка теста:', e); process.exit(1); });
