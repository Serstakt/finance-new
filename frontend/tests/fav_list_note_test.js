// Интеграционный тест: редактирование заметки из цветового списка («Красный»,
// «Синий»…) должно работать — сохранение уходит в родительский список, где
// реально лежит тикер (watchlist_items.note живёт в элементе обычного списка).
//
// Раньше renderNotesTab делал `editable = valid && !activeListId.startsWith('fav_')`
// и во fav_-списках полотно заметок было read-only («откройте обычный список»),
// хотя заметки хранятся в родительском списке так же, как флажки (см. setFavorite
// и findListWithTicker). Теперь фронтенд резолвит родительский список через
// findListWithTicker, а бэкенд дополнительно подстраховывает list_id='fav_*'
// в watchlist_service.set_note (как в set_flag).
//
// Тест берёт РЕАЛЬНЫЙ код renderNotesTab/getNotesSerialize/notesDoSave из ui.js,
// setNoteInDb из state.js и findListWithTicker из main.js через node:vm
// с заглушкой fetch.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// Вырезает window.<name> = [async] function(...) {...}; до строки '};' на
// нулевом отступе (так объявлены нужные функции в ui.js/state.js/main.js).
function extractFn(src, name) {
  const start = src.indexOf(`window.${name} =`);
  if (start === -1) throw new Error(`Не найден ${name}`);
  const end = src.indexOf('\n};', start);
  if (end === -1) throw new Error(`Не найден конец ${name}`);
  return src.slice(start, end + 3);
}

// То же для приватных function name(...) {...} без window-обёртки.
function extractPlainFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`Не найден ${name}`);
  const end = src.indexOf('\n}', start);
  if (end === -1) throw new Error(`Не найден конец ${name}`);
  return src.slice(start, end + 2);
}

const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'main.js'), 'utf8');
const stateSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'state.js'), 'utf8');
const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'ui.js'), 'utf8');

const code = [
  extractFn(stateSrc, 'setNoteInDb'),      // реальный сетевой вызов /api/watchlist/note
  extractFn(stateSrc, 'noteKey'),
  extractFn(mainSrc, 'findListWithTicker'),
  extractFn(uiSrc, 'escapeHtml'),
  extractFn(uiSrc, 'renderNotesTab'),
  extractFn(uiSrc, 'updateNotesToolbar'),
  extractFn(uiSrc, 'notesDoSave'),
  extractPlainFn(uiSrc, 'getNotesSerialize'),
].join('\n\n');

// ---------- Окружение ----------
const noteRequests = []; // [{url, body}] — все вызовы /api/watchlist/note

function makeNode(id) {
  return {
    id,
    _html: '',
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); this._text = String(v).replace(/<[^>]*>/g, '').trim(); },
    _text: '',
    get textContent() { return this._text; },
    contentEditable: '',
    classList: {
      _set: new Set(),
      toggle(c, on) { if (on) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    dataset: {},
  };
}

const editor = makeNode('notes-editor');
const status = makeNode('notes-editor-status');

const sandbox = {
  console, setTimeout, clearTimeout, Promise, JSON, Object, Array, String, RegExp, fetch,
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  log: () => {},
  document: {
    getElementById: (id) => (id === 'notes-editor' ? editor : id === 'notes-editor-status' ? status : null),
  },
  // Заглушка сети объявлена в Node-скоупе: замыкание на noteRequests из vm-
  // контекста не работает (там свободные переменные резолвятся глобалом).
  fetchWithTimeout: async (url, opts) => {
    if (String(url).includes('/api/watchlist/note')) {
      noteRequests.push({ url: String(url), body: JSON.parse(opts.body) });
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok' }) };
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

vm.runInContext(`
  window.API_BASE = '';
  window.NOTE_MAX_LEN = 500;
  window.appState = {
    activeListId: 'fav_red',
    lists: {
      default: { name: 'Основной', tickers: ['SBER', 'GAZP'], activeSymbol: 'SBER', collapsedSections: [] },
      list_2:  { name: 'Второй',   tickers: ['LKOH'],        activeSymbol: '', collapsedSections: [] },
      fav_red: { name: 'Красный',  tickers: ['SBER'],        activeSymbol: 'SBER', collapsedSections: [], isFavoriteList: true },
    },
    favorites: { SBER: 'red' },
    notes: { 'default|SBER': 'Почему слежу за SBER' },
  };
`, sandbox);
vm.runInContext(code, sandbox);

(async () => {
  // 1) Заметка по тикеру из fav_-списка «Красный»: полотно должно стать
  //    редактируемым, а ключ заметки — ссылаться на родительский список.
  await vm.runInContext(`renderNotesTab('SBER')`, sandbox);
  assert(editor.contentEditable === 'true', 'Во fav_-списке полотно заметок редактируемо');
  assert(String(editor.innerHTML).includes('Почему слежу за SBER'),
    'Отображена заметка из родительского списка (default|SBER)');
  assert(sandbox.window.__notesEditorState.key === 'default|SBER',
    'Ключ заметки резолвится в родительский список, а не в fav_red');

  // 2) Автосохранение из fav_-списка: запрос уходит в родительский список.
  editor.innerHTML = 'Новая заметка из Красного';
  vm.runInContext(`window.__notesEditorState.value = 'Почему слежу за SBER'`, sandbox);
  await vm.runInContext(`notesDoSave()`, sandbox);
  await new Promise(r => setTimeout(r, 0));
  assert(noteRequests.length === 1, 'Во fav_-списке вызван POST /api/watchlist/note');
  const req = noteRequests[0] || {};
  assert(req.body && req.body.list_id === 'default',
    'Запрос ушёл в родительский список (default), а не в fav_red');
  assert(req.body && req.body.symbol === 'SBER' && req.body.note === 'Новая заметка из Красного',
    'В запросе передан символ SBER и новый текст заметки');
  assert(sandbox.appState.notes['default|SBER'] === 'Новая заметка из Красного',
    'Локальный кэш appState.notes обновлён по ключу родительского списка');

  // 3) Обычный список — поведение без изменений: запрос в активный список.
  noteRequests.length = 0;
  vm.runInContext(`appState.activeListId = 'default'`, sandbox);
  await vm.runInContext(`renderNotesTab('GAZP')`, sandbox);
  assert(editor.contentEditable === 'true', 'В обычном списке полотно заметок редактируемо');
  assert(sandbox.window.__notesEditorState.key === 'default|GAZP',
    'В обычном списке ключ заметки — активный список');
  editor.innerHTML = 'Заметка по GAZP';
  vm.runInContext(`window.__notesEditorState.value = ''`, sandbox);
  await vm.runInContext(`notesDoSave()`, sandbox);
  await new Promise(r => setTimeout(r, 0));
  assert(noteRequests.length === 1 && noteRequests[0].body.list_id === 'default'
    && noteRequests[0].body.symbol === 'GAZP',
    'В обычном списке запрос уходит в активный список напрямую');

  // 4) Строка-раздел (SECTION:) — полотно остаётся неактивным.
  await vm.runInContext(`renderNotesTab('SECTION:Россия')`, sandbox);
  assert(editor.contentEditable === 'false', 'Для SECTION:-строк полотно неактивно');

  console.log(failures ? `\n${failures} TEST(S) FAILED` : '\nALL TESTS PASSED');
  process.exit(failures ? 1 : 0);
})();
