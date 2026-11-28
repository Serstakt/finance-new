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

// === 3. Мультипликаторы по текущей капитализации (reportsMarketCell) ===
// Сбербанк-подобные данные: капитализация 6 230 млрд ₽.
const CAP = 6230e9;
const qColumn = {
  kind: 'quarter',
  values: {
    net_profit: { v: 100, u: 'bn' },
    equity: { v: 7000, u: 'bn' },
    ebitda: { v: 2000, u: 'bn' },
    net_debt: { v: -500, u: 'bn' },
    revenue: { v: 2000, u: 'bn' },
  },
};
const peQ = R.reportsMarketCell('pe', qColumn, CAP);
assert(Math.abs(peQ.v - 6230 / (100 * 4)) < 1e-9 && peQ.u === 'x',
  'P/E квартала: капитализация / (прибыль × 4)');
const psQ = R.reportsMarketCell('ps', qColumn, CAP);
assert(Math.abs(psQ.v - 6230 / (2000 * 4)) < 1e-9,
  'P/S квартала приводится к году');
const pbQ = R.reportsMarketCell('pb', qColumn, CAP);
assert(Math.abs(pbQ.v - 6230 / 7000) < 1e-9, 'P/B: капитализация / капитал');
const evQ = R.reportsMarketCell('ev_ebitda', qColumn, CAP);
assert(Math.abs(evQ.v - (6230 - 500) / 2000) < 1e-9,
  'EV/EBITDA: чистая денежная позиция уменьшает EV');
const evNoDebt = R.reportsMarketCell('ev_ebitda', { kind: 'year', values: { ebitda: { v: 2000, u: 'bn' } } }, CAP);
assert(Math.abs(evNoDebt.v - 6230 / 2000) < 1e-9,
  'EV/EBITDA без строки долга: EV ≈ капитализация');
const peHalf = R.reportsMarketCell('pe', { kind: 'half', values: { net_profit: { v: 100, u: 'bn' } } }, CAP);
assert(Math.abs(peHalf.v - 6230 / 200) < 1e-9, 'P/E полугодия: ×2');
assert(R.reportsMarketCell('pe', { kind: 'quarter', values: { net_profit: { v: 100, u: 'raw' } } }, CAP) === null,
  'статья «как в отчёте» без единиц не годится для рыночного расчёта');
assert(R.reportsMarketCell('pe', qColumn, null) === null,
  'нет капитализации — мультипликатор не выдумывается');
assert(R.reportsMarketCell('pe', { kind: 'quarter', values: {} }, CAP) === null,
  'нет статьи прибыли — мультипликатор не выдумывается');
const peNeg = R.reportsMarketCell('pe', { kind: 'year', values: { net_profit: { v: -100, u: 'bn' } } }, CAP);
assert(peNeg !== null && peNeg.v < 0, 'отрицательная прибыль — отрицательный P/E');
const peBank = R.reportsMarketCell('pe', {
  kind: 'quarter',
  values: {
    net_profit_shareholders: { v: 200, u: 'bn' },
    net_profit_total: { v: 210, u: 'bn' },
    net_profit: { v: 100, u: 'bn' },
  },
}, CAP);
assert(Math.abs(peBank.v - 6230 / (200 * 4)) < 1e-9,
  'у банка P/E считается от прибыли акционерам');

// === 4. Строка «Капитализация» (живое значение во всех колонках) ===
const col2026 = { kind: 'quarter', values: { net_profit: { v: 100, u: 'bn' } } };
const col2025 = { kind: 'quarter', values: { net_profit: { v: 90, u: 'bn' } } };
R.reportsSetMarketCap(6230e9, '23:49:55');
const capCell = R.reportsCellForMetric('market_cap', col2026);
assert(capCell && capCell.v === 6230 && capCell.u === 'bn',
  'живая капитализация в млрд ₽');
assert(R.reportsCellForMetric('market_cap', col2025) !== null,
  'капитализация показывается в каждой колонке, не только в свежей');
const storedCap = R.reportsCellForMetric('market_cap', { kind: 'year', values: { market_cap: { v: 5000, u: 'bn' } } });
assert(storedCap && storedCap.v === 5000,
  'капитализация из отчёта приоритетнее живой');
R.reportsSetMarketCap(null, '');
assert(R.reportsCellForMetric('market_cap', col2026) === null,
  'нет живой капитализации — прочерк, число не выдумывается');

console.log();
if (failures) {
  console.error(`❌ Провалено проверок: ${failures}`);
  process.exit(1);
}
console.log('✅ Все проверки раздела «Отчетность» (фронтенд) пройдены');
