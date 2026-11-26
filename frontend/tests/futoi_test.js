// Тест FUTOI (js/futoi.js): чистые функции построения рядов и форматирования.
// Загружает РЕАЛЬНЫЙ futoi.js в node:vm (без document — инициализация раздела
// пропускается) и проверяет:
//   * futoiPointMetrics — метрики дня: лонги/шорты/нетто/доли, дельты;
//   * futoiBuildSeries — набор линий для каждого режима графика;
//   * futoiNiceTicks — «красивые» деления оси (включая ноль и отрицательные);
//   * форматирование чисел (компактное, проценты, знаковые значения).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log('PASS:', msg);
  else { failures++; console.error('FAIL:', msg); }
}

// Минимальное окружение: futoi.js на верхнем уровне пишет функции в window,
// а работа с DOM/localStorage/fetch остаётся внутри функций и не вызывается.
const sandbox = {
  window: {},
  console,
  Intl,
  Math,
  Date,
  Set,
  Map,
  Number,
  String,
  Array,
  Object,
  JSON,
  isFinite,
  setTimeout,
  clearTimeout,
};
sandbox.window.API_BASE = '';
vm.createContext(sandbox);
const code = fs.readFileSync(path.join(__dirname, '..', 'js', 'futoi.js'), 'utf8');
vm.runInContext(code, sandbox, { filename: 'futoi.js' });
const F = sandbox.window;

// === Фикстура: три торговых дня, в третьем у физлиц нет данных ===
const series = [
  {
    date: '2026-11-10',
    fiz: { pos: 80, pos_long: 100, pos_short: -20 },
    yur: { pos: -80, pos_long: 40, pos_short: -120 },
    total: { pos: 0, pos_long: 140, pos_short: -140 },
  },
  {
    date: '2026-11-11',
    fiz: { pos: 120, pos_long: 150, pos_short: -30 },
    yur: { pos: -10, pos_long: 50, pos_short: -40 },
    total: { pos: 0, pos_long: 200, pos_short: -70 },
  },
  {
    date: '2026-11-12',
    fiz: null,
    yur: { pos: 10, pos_long: 60, pos_short: -50 },
    total: { pos: 0, pos_long: 60, pos_short: -50 },
  },
];

// === 1. Метрики дня ===
const m1 = F.futoiPointMetrics(series[0], null);
assert(m1.fizLong === 100 && m1.fizShort === 20 && m1.fizNet === 80,
  'метрики: лонги/шорты по модулю/нетто физлиц');
assert(Math.abs(m1.fizShortShare - (20 / 120) * 100) < 1e-9,
  'метрики: доля шортов физлиц = short / (long + short)');
assert(m1.fizNetChange === null, 'метрики: у первого дня нет дельты');
assert(m1.yurLong === 40 && m1.yurShort === 120 && m1.yurNet === -80,
  'метрики: юрлица разобраны отдельно');
assert(m1.oiLong === 140 && m1.oiShort === 140,
  'метрики: открытый интерес из total (лонги/шорты)');

const m2 = F.futoiPointMetrics(series[1], series[0]);
assert(m2.fizNetChange === 40, 'метрики: дневное изменение нетто физлиц (120 − 80)');
assert(m2.yurNetChange === 70, 'метрики: дневное изменение нетто юрлиц (−10 − (−80))');
assert(Math.abs(m2.fizShortShare - (30 / 180) * 100) < 1e-9,
  'метрики: доля шортов на втором дне');

const m3 = F.futoiPointMetrics(series[2], series[1]);
assert(m3.fizLong === null && m3.fizShort === null && m3.fizNet === null,
  'метрики: отсутствующая группа -> null, а не 0');
assert(m3.fizNetChange === null, 'метрики: дельта без группы -> null');
assert(m3.yurNet === 10 && m3.yurNetChange === 20, 'метрики: юрлица считаются независимо');

// === 2. Наборы линий по режимам ===
const modes = {
  longshort: ['fizLong', 'fizShort', 'yurLong', 'yurShort'],
  net: ['fizNet', 'yurNet'],
  shortshare: ['fizShortShare', 'yurShortShare'],
  longshare: ['fizLongShare', 'yurLongShare'],
  change: ['fizNetChange', 'yurNetChange'],
  oi: ['oiLong', 'oiShort'],
};
Object.keys(modes).forEach(mode => {
  const built = F.futoiBuildSeries({ series }, mode);
  assert(built.lines.map(l => l.key).join(',') === modes[mode].join(','),
    `режим ${mode}: ожидаемые линии`);
  assert(built.lines.every(l => l.values.length === series.length),
    `режим ${mode}: длина значений = числу дней`);
  assert(built.lines.every(l => l.color && l.label),
    `режим ${mode}: у линий есть подпись и цвет`);
});

const netBuilt = F.futoiBuildSeries({ series }, 'net');assert(netBuilt.lines[0].values[0] === 80 && netBuilt.lines[0].values[2] === null,
  'режим net: значения и null для пропущенного дня');
assert(netBuilt.unit === 'signed' && netBuilt.includeZero === true,
  'режим net: знаковая шкала с нулём');

const shareBuilt = F.futoiBuildSeries({ series }, 'shortshare');
assert(shareBuilt.unit === 'percent', 'режим shortshare: проценты');
assert(Math.abs(shareBuilt.lines[0].values[1] - (30 / 180) * 100) < 1e-9,
  'режим shortshare: значение доли шортов');

const changeBuilt = F.futoiBuildSeries({ series }, 'change');
assert(changeBuilt.lines[0].values[0] === null && changeBuilt.lines[0].values[1] === 40,
  'режим change: null в первый день, дельта во второй');

// Неизвестный режим -> фолбэк на longshort, пустые данные -> без исключений
const fallback = F.futoiBuildSeries({ series }, 'nope');
assert(fallback.mode === 'longshort', 'неизвестный режим -> longshort');
const empty = F.futoiBuildSeries({ series: [] }, 'net');
assert(empty.lines.length === 2 && empty.lines[0].values.length === 0,
  'пустой ряд -> пустые значения без исключений');

// === 3. Красивые деления оси ===
assert(F.futoiNiceTicks(0, 100, 5).join(',') === '0,20,40,60,80,100',
  'nice ticks: 0..100 шаг 20');
assert(F.futoiNiceTicks(-100, 100, 4).join(',') === '-100,-50,0,50,100',
  'nice ticks: отрицательный диапазон включает 0');
const flat = F.futoiNiceTicks(5, 5, 5);
assert(flat.length >= 2 && flat[0] < 5 && flat[flat.length - 1] > 5,
  'nice ticks: одинаковый min/max расширяется вокруг значения');
assert(F.futoiNiceTicks(NaN, 10, 5).length === 0, 'nice ticks: NaN -> пустой список');

// === 4. Форматирование ===
assert(F.futoiFormatCompact(1200000) === '1,2 млн', 'compact: 1,2 млн');
assert(F.futoiFormatCompact(1500000) === '1,5 млн', 'compact: 1,5 млн');
assert(F.futoiFormatCompact(25000) === '25 тыс', 'compact: 25 тыс');
assert(F.futoiFormatCompact(1500) === '1,5 тыс', 'compact: 1,5 тыс');
assert(F.futoiFormatCompact(-1500000) === '−1,5 млн', 'compact: отрицательное значение');
assert(F.futoiFormatCompact(null) === '—', 'compact: null -> прочерк');
assert(F.futoiFormatPercent(44.94) === '44,9%', 'percent: запятая и один знак');
assert(F.futoiFormatPercent(null) === '—', 'percent: null -> прочерк');
assert(F.futoiFormatCount(22836).replace(/\u00a0/g, ' ') === '22 836',
  'count: тысячи разделены пробелом');

console.log();
if (failures) {
  console.error(`❌ Провалено проверок: ${failures}`);
  process.exit(1);
}
console.log('✅ Все проверки FUTOI (frontend) пройдены');
