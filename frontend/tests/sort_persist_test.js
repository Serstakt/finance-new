// Регрессионный тест: сортировка колонок watchlist (Тикер/Цена/Изм./Изм.%)
// должна переживать перезагрузку страницы. Гоняет РЕАЛЬНЫЙ state.js через
// node:vm с localStorage-заглушкой: сохранение при клике по заголовку
// (saveSortState из ui.js), восстановление при loadState (F5) и очистка
// ключа при сбросе сортировки (смена списка / импорт / drag&drop).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// ---------- localStorage-заглушка ----------
const store = new Map();
const localStorageMock = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

// ---------- Окружение ----------
const sandbox = {
  console,
  localStorage: localStorageMock,
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  document: {
    getElementById: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  },
  setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  JSON, Math, Date, Promise, Map, Set, String, Number, Object, Array, RegExp, Infinity,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'js', 'state.js'), 'utf8'), sandbox);

// Подсветка заголовков — реальный resetSortHeaders из ui.js в этом тесте не
// нужен (он требует DOM), записываем вызовы заглушкой.
const headerCalls = [];
sandbox.resetSortHeaders = (...args) => headerCalls.push(args);
const KEY = sandbox.SORT_STATE_KEY;

// --- 1) Клик по заголовку: сохранение в localStorage ---
sandbox.currentSort = { field: 'changePct', direction: 'desc' };
sandbox.saveSortState();
let saved = JSON.parse(localStorageMock.getItem(KEY));
assert(saved && saved.field === 'changePct' && saved.direction === 'desc',
  'saveSortState: колонка и направление записаны в localStorage');
assert(!headerCalls.length, 'saveSortState: заголовки не трогает — это делает render');

// --- 2) Перезагрузка (F5): loadState восстанавливает сортировку ---
sandbox.currentSort = { field: null, direction: 'asc' };
headerCalls.length = 0;
sandbox.loadState();
assert(sandbox.currentSort.field === 'changePct' && sandbox.currentSort.direction === 'desc',
  'loadState: сортировка восстановлена из localStorage после перезагрузки');
assert(headerCalls.length === 1 && headerCalls[0][0] === 'changePct' && headerCalls[0][1] === 'desc',
  'loadState: активный заголовок подсвечен сохранённым направлением');
assert(JSON.parse(localStorageMock.getItem('watchlist_sort')).field === 'changePct',
  'loadState: ключ в localStorage остаётся после чтения');

// --- 3) Сброс сортировки очищает и память, и localStorage ---
headerCalls.length = 0;
sandbox.resetSortState();
assert(sandbox.currentSort.field === null && sandbox.currentSort.direction === 'asc',
  'resetSortState: currentSort сброшен в памяти');
assert(localStorageMock.getItem(KEY) === null,
  'resetSortState: ключ удалён — сортировка не всплывёт после F5');
assert(headerCalls.length === 1 && headerCalls[0].length === 0,
  'resetSortState: подсветка заголовков снята');

// --- 4) Пустое хранилище и битый/неизвестный JSON не ломают старт ---
sandbox.currentSort = { field: null, direction: 'asc' };
sandbox.loadSortState();
assert(sandbox.currentSort.field === null, 'loadSortState: без сохранения сортировка выключена');

for (const bad of ['{битый', '{"field":"unknown","direction":"desc"}', 'null']) {
  localStorageMock.setItem(KEY, bad);
  sandbox.currentSort = { field: null, direction: 'asc' };
  sandbox.loadSortState();
  assert(sandbox.currentSort.field === null, `loadSortState: "${bad}" игнорируется`);
}
localStorageMock.removeItem(KEY);

// --- 5) Статическая защита: точки клика/сброса используют общий механизм ---
const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'state.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
assert(/setupColumnHeaders[\s\S]*?saveSortState\(\)/.test(uiSrc),
  'ui.js: клик по заголовку вызывает saveSortState');
assert(/switchList[\s\S]*?resetSortState\(\)/.test(stateSrc),
  'state.js: смена списка вызывает resetSortState');
assert((mainSrc.match(/resetSortState\(\)/g) || []).length === 2,
  'main.js: импорт и drag&drop сбрасывают сортировку через resetSortState');
// прямые сбросы допустимы только в else-фолбэке (resetSortState ещё не определён)
assert((mainSrc.match(/currentSort = \{ field: null, direction: 'asc' \};/g) || []).length === 2,
  'main.js: прямых сбросов currentSort в обход resetSortState не осталось');

if (failures) {
  console.error(`\n${failures} FAILED`);
  process.exit(1);
}
console.log('\nALL TESTS PASSED');
