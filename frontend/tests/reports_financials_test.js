// Тест раздела «Отчетность» (js/reports.js): чистые функции форматирования
// и расчёта изменений. Загружает реальный reports.js в node:vm — функции
// рендера не вызываются, поэтому document/fetch не нужны.
//
// Проверяем:
//   * форматирование млрд ₽ / процентов / мультипликаторов / ₽ на акцию;
//   * пустые значения и отрицательные числа;
//   * «Изм. %» — сравнение с предыдущим периодом ТОГО ЖЕ типа;
//   * доступность режима изменений только при двух периодах одного типа.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

const sandbox = {
  window: {},
  console,
  Intl,
  Math,
  Date,
  Number,
  String,
  Array,
  Object,
  JSON,
  isFinite,
  setTimeout,
  clearTimeout,
  sessionStorage: {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  },
};
sandbox.window.API_BASE = '';
vm.createContext(sandbox);
const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'reports.js'), 'utf8');
vm.runInContext(code, sandbox, { filename: 'reports.js' });
const R = sandbox.window;

// === 1. Форматирование ===
assert(R.reportsFormatCell(2059.279, 'money', 'bn').replace(/\u00a0/g, ' ') === '2 059,3',
  'выручка: млрд ₽ с одним знаком после запятой');
assert(R.reportsFormatCell(318.7, 'money', 'bn') === '318,7',
  'долг: млрд ₽');
assert(R.reportsFormatCell(734.23, 'share', 'share') === '734,23 ₽',
  'EPS: рубли на акцию');
assert(R.reportsFormatCell(39.5936, 'pct', 'pct') === '39,6%',
  'рентабельность: процент');
assert(R.reportsFormatCell(0.3909, 'x', 'x') === '0,39×',
  'мультипликатор: ×');
assert(R.reportsFormatCell(null, 'money', 'bn') === '—',
  'пустое значение — прочерк');
assert(R.reportsFormatChange(8) === '+8%', 'рост со знаком +');
assert(R.reportsFormatChange(-12.34) === '-12,3%', 'падение со знаком −');
assert(R.reportsFormatChange(null) === '—', 'нет данных — прочерк');

// === 2. Изменение к предыдущему периоду того же типа ===
const columns = [
  { kind: 'half', values: { revenue: { v: 2059.279, u: 'bn' } } },  // 2026 1п
  { kind: 'year', values: { revenue: { v: 3767.768, u: 'bn' } } },  // 2025
  { kind: 'half', values: { revenue: { v: 1907.603, u: 'bn' } } },  // 2025 1п
  { kind: 'year', values: { revenue: { v: 4420.565, u: 'bn' } } },  // 2024
];
const halfChange = R.reportsChangeFor('revenue', 0, columns);
assert(Math.abs(halfChange - ((2059.279 - 1907.603) / 1907.603) * 100) < 1e-9,
  'полугодие 2026 сравнивается с полугодием 2025, а не с годом');
const yearChange = R.reportsChangeFor('revenue', 1, columns);
assert(Math.abs(yearChange - ((3767.768 - 4420.565) / 4420.565) * 100) < 1e-9,
  'год 2025 сравнивается с 2024');
assert(R.reportsChangeFor('revenue', 2, columns) === null,
  'у последнего полугодия нет предыдущего — прочерк');
assert(R.reportsChangeFor('missing', 0, columns) === null,
  'отсутствующий показатель не даёт изменения');

assert(R.reportsCanChangeView(columns) === true,
  'два полугодия и два года — режим изменений доступен');
assert(R.reportsCanChangeView([
  { kind: 'half', values: {} }, { kind: 'year', values: {} },
]) === false, 'разные типы периодов без пары — режим изменений недоступен');

console.log();
if (failures) {
  console.error(`❌ Провалено проверок: ${failures}`);
  process.exit(1);
}
console.log('✅ Все проверки раздела «Отчетность» (фронтенд) пройдены');
