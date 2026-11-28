"""Финансовые показатели компаний из загруженных отчётов.

Раздел «Отчетность» показывает таблицу в духе smart-lab: строки — статьи
отчётности (выручка, EBITDA, чистая прибыль, долг…), колонки — периоды
(квартал / полугодие / 9 месяцев / год). Колонка появляется после загрузки
PDF по выбранной бумаге: reports_service распознаёт таблицы, а этот модуль
приводит их к единому набору показателей и склеивает периоды.

Почему нужен отдельный слой:
  * в отчётах разных компаний статьи называются по-разному
    («Выручка от реализации», «Revenue», «Чистые денежные средства,
    полученные от операционной деятельности»);
  * колонки приходят либо с готовыми подписями («За 6 месяцев, 30 июня
    2026»), либо как «Значение 1/2», а годы лежат в строке «Примечание»;
  * доходная таблица и баланс могут быть в разных единицах
    (миллионы/тысячи рублей).

Сопоставление статей — по названию (regexp) с приоритетом: например,
«Чистая прибыль, относящаяся к акционерам» важнее «Чистая прибыль от
продолжающейся деятельности». Денежные значения приводятся к млрд ₽,
если единицы измерения распознаны. Производные строки (EBITDA, FCF,
чистый долг, рентабельность) считаются только при наличии обеих исходных
статей — выдумывать числа нельзя.
"""
from __future__ import annotations

import calendar
import json
import re
from dataclasses import dataclass
from datetime import date
from typing import Optional

from backend.database.database import get_session, safe_create_all
from backend.database.models import ReportDocument, WatchlistItem

safe_create_all()

# Единицы показателя в ответе API (фронтенд по ним форматирует числа).
UNIT_MONEY = "money"
UNIT_PER_SHARE = "share"
UNIT_PERCENT = "pct"
UNIT_RATIO = "x"

# Группы строк таблицы — фронтенд рисует между ними заголовки-разделители.
GROUP_INCOME = "income"
GROUP_PER_SHARE = "per_share"
GROUP_CASHFLOW = "cashflow"
GROUP_BALANCE = "balance"
GROUP_RATIOS = "ratios"

GROUP_LABELS = {
    GROUP_INCOME: "Прибыль и убытки",
    GROUP_PER_SHARE: "На акцию",
    GROUP_CASHFLOW: "Денежный поток",
    GROUP_BALANCE: "Баланс",
    GROUP_RATIOS: "Мультипликаторы",
}

# =============================================================================
# СЕКТОРЫ
# =============================================================================
# Набор строк таблицы зависит от сектора компании: у банка свои статьи
# (ЧПД, комиссионные, резервы…), у остальных — общий шаблон. Сектор пока
# определяется статичным списком тикеров Мосбиржи; расширяется по мере
# необходимости (нефтегаз и прочие — следующие шаблоны).
SECTOR_DEFAULT = "default"
SECTOR_BANK = "bank"

BANK_TICKERS = frozenset({
    "SBER", "SBERP",   # Сбербанк (ао/ап)
    "VTBR",            # ВТБ
    "CBOM", "SVCB",    # Совкомбанк (ао/ап)
    "TCSG",            # ТКС Холдинг (Т-Банк)
    "ROSB",            # Росбанк
    "MTSB",            # МТС Банк
    "BSPB", "BSPBP",   # Банк «Санкт-Петербург» (ао/ап)
    "ZILL",            # Банк «Зенит»
    "VOSK",            # Восточный экспресс банк
})

# Признак банковской отчетности в распознанных колонках: если ЧПД
# извлечён, отчет банковский независимо от тикера (список тикеров
# неполон — новые банки, апы, случайные тикеры watchlist).
BANK_SENTINEL_METRIC = "net_interest_income"


def sector_for_symbol(symbol: object) -> str:
    """Сектор компании по тикеру: «bank» или общий шаблон."""
    value = str(symbol or "").strip().upper()
    code = value.split(":", 1)[1] if ":" in value else value
    return SECTOR_BANK if code in BANK_TICKERS else SECTOR_DEFAULT


def sector_for_columns(symbol: object, columns: list) -> str:
    """Сектор по тикеру, а при наличии банковских статей — по отчету."""
    if sector_for_symbol(symbol) == SECTOR_BANK:
        return SECTOR_BANK
    for column in columns:
        values = column.get("values") or {}
        if BANK_SENTINEL_METRIC in values:
            return SECTOR_BANK
    return SECTOR_DEFAULT


@dataclass(frozen=True)
class MetricDef:
    """Описание строки итоговой таблицы.

    patterns — регулярки по нормализованному названию статьи (нижний
    регистр, без пунктуации). Чем раньше шаблон в кортеже, тем выше его
    приоритет: так «Чистая прибыль, относящаяся к акционерам» выигрывает
    у «Чистая прибыль от продолжающейся деятельности».
    combine — "best" (выбрать лучшую строку) или "sum" (сложить
    краткосрочный и долгосрочный долг, если нет строки «Итого»).
    absolute — показывать значение по модулю (расходы в отчёте идут в
    скобках, а в таблице удобнее положительные суммы).
    """

    key: str
    label: str
    unit: str
    group: str
    source: str              # income | cashflow | balance | derived
    patterns: tuple[str, ...] = ()
    combine: str = "best"
    absolute: bool = False
    core: bool = False
    derived: bool = False
    hint: str = ""


METRICS = (
    MetricDef(
        "revenue", "Выручка", UNIT_MONEY, GROUP_INCOME, "income",
        patterns=(
            r"^выручка от реализации",
            r"^выручка$",
            r"\bвыручка\b",
            r"^revenue\b",
        ),
        core=True,
    ),
    MetricDef(
        "operating_profit", "Операционная прибыль", UNIT_MONEY, GROUP_INCOME, "income",
        patterns=(
            r"^операционн\w* прибыль",
            r"прибыл\w* от операционн\w* деятельности",
            r"^операционный результат",
            r"^operating profit",
        ),
        core=True,
    ),
    MetricDef(
        "ebitda", "EBITDA", UNIT_MONEY, GROUP_INCOME, "income",
        patterns=(r"\bebitda\b",),
        core=True,
        derived=True,
        hint="Операционная прибыль + амортизация, если EBITDA не указана в отчёте.",
    ),
    MetricDef(
        "net_profit", "Чистая прибыль", UNIT_MONEY, GROUP_INCOME, "income",
        patterns=(
            r"^(?!.*продолжающ).*чист\w*.*прибыл\w*.*относящ\w*.*акционер",
            r"^(?:чист\w* убыток )?чист\w* прибыль$",
            r"чист\w*.*прибыл\w*.*относящ\w*.*акционер",
            r"чист\w*.*прибыл\w*",
        ),
        core=True,
        hint="Прибыль, относящаяся к акционерам; если её нет — прибыль за период.",
    ),
    MetricDef(
        "amortization", "Амортизация", UNIT_MONEY, GROUP_INCOME, "income",
        patterns=(
            r"^износ и амортизац",
            r"^амортизац",
            r"\bамортизац",
            r"^износ",
            r"\bdepreciation\b",
        ),
        absolute=True,
    ),
    MetricDef(
        "interest_expense", "Процентные расходы", UNIT_MONEY, GROUP_INCOME, "income",
        patterns=(
            r"^процентн\w* расход",
            r"расход\w* по процентам",
            r"^финансов\w* расход",
            r"\binterest expense",
        ),
        absolute=True,
    ),
    MetricDef(
        "eps", "EPS", UNIT_PER_SHARE, GROUP_PER_SHARE, "income",
        patterns=(
            r"^(?!.*продолжающ).*прибыл\w* на акцию",
            r"прибыл\w* на акцию",
            r"на одну .*акцию",
            r"^earnings per share",
        ),
        hint="Прибыль на акцию — как в отчёте (валюта и число акций не пересчитываются).",
    ),
    MetricDef(
        "operating_cash_flow", "Операционный денежный поток", UNIT_MONEY,
        GROUP_CASHFLOW, "cashflow",
        patterns=(
            r"^чист\w* денежн\w* средства .*операционн",
            r"денежн\w* средства .*от операционн",
            r"^net cash .*operating",
        ),
        core=True,
    ),
    MetricDef(
        "capex", "CAPEX", UNIT_MONEY, GROUP_CASHFLOW, "cashflow",
        patterns=(
            r"^капитальн\w* затраты",
            r"^капитальн\w* вложения",
            r"^приобретение .*основных средств",
            r"приобретение основных средств",
            r"^purchase of property",
            r"^capital expenditure",
        ),
        absolute=True,
        core=True,
    ),
    MetricDef(
        "fcf", "FCF", UNIT_MONEY, GROUP_CASHFLOW, "derived",
        core=True,
        derived=True,
        hint="Операционный денежный поток − CAPEX.",
    ),
    MetricDef(
        "total_assets", "Активы", UNIT_MONEY, GROUP_BALANCE, "balance",
        patterns=(
            r"^итого активы$",
            r"^активы$",
            # Активы = капитал + обязательства — банковские балансы
            # (Совкомбанк) подводят итог этой строкой.
            r"^итого капитал и обязательств",
            # «Итого» под разделом «Активы» и «Всего активов» —
            # банковские балансы (Совкомбанк, ВТБ).
            r"^итого$",
            r"^всего актив",
            r"^total assets$",
        ),
        core=True,
    ),
    MetricDef(
        "equity", "Капитал", UNIT_MONEY, GROUP_BALANCE, "balance",
        patterns=(
            r"^итого капитал$",
            r"^итого капитал",
            r"^total equity$",
            r"^собственн\w* капитал",
            r"^итого акционерн\w* капитал",
            r"^капитал$",
        ),
        core=True,
    ),
    MetricDef(
        "debt", "Долг", UNIT_MONEY, GROUP_BALANCE, "balance",
        patterns=(
            r"^итого .*кредит.*займ",
            r"^итого (?:кредиты и займы|заемн\w* средства|долг|долгов\w* обязательств)$",
            r"^итого кредит\w*",
            r"^итого заемн\w*",
            r"кредиты и займы",
            r"^заемн\w* средства",
            r"^долгосрочн\w* задолженность по кредитам",
            r"^долгов\w* обязательств",
            r"^долг$",
            r"^total debt",
            r"^total borrowings",
            r"^loans and borrowings",
        ),
        combine="sum",
        core=True,
        hint="Краткосрочные + долгосрочные кредиты и займы (строка «Итого», если есть).",
    ),
    MetricDef(
        "cash", "Денежные средства", UNIT_MONEY, GROUP_BALANCE, "balance",
        patterns=(
            r"^денежн\w* средства и .*эквивалент",
            r"^денежн\w* средства$",
            r"^cash and cash equivalents$",
            r"^cash$",
        ),
        core=True,
    ),
    MetricDef(
        "net_debt", "Чистый долг", UNIT_MONEY, GROUP_BALANCE, "derived",
        core=True,
        derived=True,
        hint="Долг − денежные средства. Отрицательное значение — чистая денежная позиция.",
    ),
    MetricDef(
        "ebitda_margin", "Рентабельность EBITDA", UNIT_PERCENT, GROUP_RATIOS, "derived",
        derived=True,
        hint="EBITDA / выручка × 100.",
    ),
    MetricDef(
        "net_margin", "Чистая рентабельность", UNIT_PERCENT, GROUP_RATIOS, "derived",
        derived=True,
        hint="Чистая прибыль / выручка × 100.",
    ),
    MetricDef(
        "debt_ebitda", "Долг / EBITDA", UNIT_RATIO, GROUP_RATIOS, "derived",
        derived=True,
        hint="Долг / EBITDA.",
    ),
)

METRICS_BY_KEY = {metric.key: metric for metric in METRICS}

# =============================================================================
# БАНКОВСКИЙ ШАБЛОН
# =============================================================================
# Статьи банковских МСФО (Сбербанк, ВТБ…) и рыночные строки. Денежные
# статьи парсятся из ОПиУ/баланса, мультипликаторы и рентабельность —
# только если такая строка реально есть в загруженном отчёте (source
# "any" — таблица может быть любой): рыночных данных (цена × число
# акций, кредитный портфель для COR/NPL) раздел не подтягивает, а
# выдумывать числа нельзя.
BANK_ONLY_METRICS = (
    MetricDef(
        "net_interest_income", "Чистый процентный доход", UNIT_MONEY,
        GROUP_INCOME, "income",
        patterns=(
            # Точная строка важнее производной «…после расходов по
            # кредитным убыткам», которая матчится тем же общим шаблоном.
            r"^чист\w* процентн\w* доход$",
            r"^net interest income$",
            r"^чист\w* процентн\w* доход",
            r"^net interest income",
        ),
        core=True,
    ),
    MetricDef(
        "net_fee_income", "Чистые комиссионные", UNIT_MONEY,
        GROUP_INCOME, "income",
        patterns=(
            r"^чист\w* комиссионн\w* доход$",
            r"^чист\w* комиссионн",
            r"^net fee",
            r"^net commission",
        ),
        core=True,
    ),
    MetricDef(
        "net_operating_income", "Чистый операц. доход", UNIT_MONEY,
        GROUP_INCOME, "income",
        patterns=(
            # «…до создания резерва» приоритетнее: в банковских ОПиУ это
            # основной «Чистый операционный доход», строка «после создания
            # резерва» матчится только общим шаблоном ниже.
            r"^чист\w* операционн\w* доход до",
            r"^чист\w* операционн\w* доход",
            r"^net operating income",
        ),
        core=True,
        hint="Доход до резервов: из отчета или оценка (опер. доходы + резервы + небанковский чистый доход).",
    ),
    MetricDef(
        "net_profit_shareholders", "Чистая прибыль (акционерам)", UNIT_MONEY,
        GROUP_INCOME, "income",
        patterns=(
            r"^чист\w* прибыль.*приходящ\w* на акционер",
            r"чист\w*.*прибыл\w*.*относящ\w*.*акционер",
            r"^profit attributable to (?:the )?shareholders",
            # Подстатья под заголовком «…приходящаяся на:»: «Акционеры
            # Банка» (Сбербанк) / «- акционеров Банка» (Совкомбанк).
            r"^акционер\w* банка$",
        ),
        core=True,
        hint="Прибыль, приходящаяся на акционеров банка, без неконтролирующих долей.",
    ),
    MetricDef(
        "operating_expenses", "Операционные расходы", UNIT_MONEY,
        GROUP_INCOME, "income",
        patterns=(
            r"^операционн\w* расход",
            r"^operating expenses",
            # «Непроцентные расходы» — тот же блок расходов в ОПиУ
            # Совкомбанка и Т-Банка.
            r"^непроцентн\w* расход",
        ),
        absolute=True,
        core=True,
    ),
    MetricDef(
        "provisions", "Создание резервов", UNIT_MONEY,
        GROUP_INCOME, "income",
        patterns=(
            r"^расход\w* по кредитным убыткам",
            r"^создание .*резерв.*кредит",
            r"^создание .*резерв",
            r"^резерв на возможные потери",
            r"^provision .*(?:impairment|credit)",
        ),
        absolute=True,
        core=True,
        hint="Резерв на возможные потери по кредитам, по модулю.",
    ),
    MetricDef(
        "net_profit_total", "Чистая прибыль", UNIT_MONEY,
        GROUP_INCOME, "income",
        patterns=(
            r"^чист\w* прибыль$",
            r"^чист\w* прибыль (?:убыток|за период)",
            r"^чист\w* убыток$",
            r"^прибыл\w* за отчетный период$",
            r"^profit(?: loss)? for the period$",
        ),
        core=True,
        hint="Чистая прибыль за период, включая неконтролирующие доли.",
    ),
    # Источники для расчёта чистого операционного дохода там, где такой
    # строки в отчете нет (сжатые ОПиУ). В шаблон строк их не выводим.
    MetricDef(
        "operating_income_total", "Операционные доходы (после резервов)",
        UNIT_MONEY, GROUP_INCOME, "income",
        patterns=(
            r"^операционн\w* доходы$",
            r"^operating income$",
        ),
        hint="Итог доходов ОПиУ до операционных расходов, после резервов.",
    ),
    MetricDef(
        "nonbank_net_income", "Чистый доход по небанковской деятельности",
        UNIT_MONEY, GROUP_INCOME, "income",
        patterns=(
            r"^чист\w* доход по небанковской",
            r"^net non-banking",
        ),
    ),
    MetricDef(
        "pe", "PE", UNIT_RATIO, GROUP_RATIOS, "any",
        patterns=(
            r"^p e$",
            r"\bp e ratio\b",
            r"^price to earnings",
        ),
        core=True,
        hint="Берётся из загруженного отчёта, если он содержит такую строку.",
    ),
    MetricDef(
        "pb", "PB", UNIT_RATIO, GROUP_RATIOS, "any",
        patterns=(
            r"^p b v$",
            r"^p b$",
            r"^price to book",
        ),
        core=True,
        hint="Берётся из загруженного отчёта, если он содержит такую строку.",
    ),
    MetricDef(
        "market_cap", "Капитализация", UNIT_MONEY, GROUP_RATIOS, "any",
        patterns=(
            r"^капитализация",
            r"^market capitali[sz]ation",
        ),
        core=True,
        hint="Берётся из загруженного отчёта, если он содержит такую строку.",
    ),
    MetricDef(
        "roe", "ROE", UNIT_PERCENT, GROUP_RATIOS, "any",
        patterns=(
            r"^roe$",
            r"^рентабельность капитал",
            r"^return on equity",
        ),
        core=True,
        derived=True,
        hint="Годовые: ЧП (акционерам) / Капитал × 100 (поток за период приведён к году).",
    ),
    MetricDef(
        "roa", "ROA", UNIT_PERCENT, GROUP_RATIOS, "any",
        patterns=(
            r"^roa$",
            r"^рентабельность актив",
            r"^return on assets",
        ),
        core=True,
        derived=True,
        hint="Годовые: Чистая прибыль / Активы × 100 (активы на конец периода).",
    ),
    MetricDef(
        "nim", "NIM", UNIT_PERCENT, GROUP_RATIOS, "any",
        patterns=(
            r"^nim$",
            r"^процентная маржа",
            r"^net interest margin",
        ),
        core=True,
        derived=True,
        hint="Годовые: ЧПД / Активы × 100 — приближение по активам на конец периода.",
    ),
    MetricDef(
        "npl", "NPL", UNIT_PERCENT, GROUP_RATIOS, "any",
        patterns=(
            r"^npl$",
            r"^дол\w* проблемн\w* кредит",
            r"^non performing loan",
        ),
        core=True,
        hint="Берётся из загруженного отчёта, если он содержит такую строку.",
    ),
    MetricDef(
        "cor", "COR", UNIT_PERCENT, GROUP_RATIOS, "any",
        patterns=(
            r"^cor$",
            r"^стоимость риска",
            r"^cost of risk",
        ),
        core=True,
        hint="Берётся из загруженного отчёта, если он содержит такую строку.",
    ),
    MetricDef(
        "cir", "CIR", UNIT_PERCENT, GROUP_RATIOS, "any",
        patterns=(
            r"^cir$",
            r"^cost to income",
            r"^отношение расходов к доходам",
        ),
        core=True,
        derived=True,
        hint="Операционные расходы / Чистый операц. доход × 100.",
    ),
    MetricDef(
        "deposits", "Депозиты", UNIT_MONEY, GROUP_BALANCE, "balance",
        patterns=(
            # Только клиентские средства: «Депозиты и счета банков» —
            # межбанковский блок, к депозитам клиентов не относится.
            r"^средства клиент",
            r"^текущ\w* счет\w* и депозиты клиент",
            r"^депозиты клиент",
            r"^customer (?:current accounts and )?deposits",
            r"^customer accounts",
        ),
        core=True,
        hint="Средства клиентов на текущих счетах и депозитах (баланс).",
    ),
)

BANK_ONLY_BY_KEY = {metric.key: metric for metric in BANK_ONLY_METRICS}

# Единый каталог разбора: банковские статьи распознаются всегда, а какой
# шаблон строк показывать — решает сектор компании при выдаче.
PARSING_METRICS = METRICS + BANK_ONLY_METRICS
PARSING_BY_KEY = {metric.key: metric for metric in PARSING_METRICS}

# Порядок строк банковского шаблона — как согласовано (частично
# переиспользуются ключи общего каталога: equity, total_assets).
BANK_TEMPLATE = (
    "net_interest_income",
    "net_fee_income",
    "net_operating_income",
    "net_profit_shareholders",
    "operating_expenses",
    "provisions",
    "net_profit_total",
    "pe",
    "pb",
    "equity",
    "market_cap",
    "roe",
    "roa",
    "nim",
    "npl",
    "cor",
    "cir",
    "total_assets",
    "deposits",
)

# Ключи, считающиеся из исходных статей колонки (см. _derive_column).
_BANK_DERIVED = frozenset({"roe", "roa", "nim", "cir"})

# Приоритет источника при склейке одной и той же статьи из разных таблиц:
# амортизация в ОПиУ (расход) точнее для EBITDA, чем корректировка в ДДС.
_SOURCE_PRIORITY = {"income": 0, "balance": 1, "cashflow": 2}

_MONTH_STEMS = (
    ("январ", 1), ("феврал", 2), ("март", 3), ("апрел", 4),
    ("май", 5), ("мая", 5), ("июн", 6), ("июл", 7),
    ("август", 8), ("сентябр", 9), ("октябр", 10),
    ("ноябр", 11), ("декабр", 12),
)

_MONTH_WORD_RE = (
    r"(январ\w*|феврал\w*|март\w*|апрел\w*|ма[йя]|июн\w*|июл\w*"
    r"|август\w*|сентябр\w*|октябр\w*|ноябр\w*|декабр\w*)"
)
# Между месяцем и годом в OCR-шапке вклиниваются слова пометки
# («30 сентября (не аудировано) 2026 г.») — допускаем до трёх.
_DATE_WORD_RE = re.compile(
    r"(\d{1,2})\s+" + _MONTH_WORD_RE + r"(?:\s+\w+){0,3}?\s+(\d{4})"
)
_DATE_NUM_RE = re.compile(r"(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})")
_YEAR_RE = re.compile(r"\b((?:19|20)\d{2})\b")
_YEAR_ONLY_RE = re.compile(r"^(?:19|20)\d{2}$")
_ROMAN_QUARTERS = {"i": 1, "ii": 2, "iii": 3, "iv": 4}
_WORD_QUARTERS = {
    "перв": 1, "втор": 2, "трет": 3, "четверт": 4,
}


def _norm(text: object) -> str:
    """Нижний регистр, ё→е, без пунктуации — для сопоставления статей."""
    value = str(text or "").lower().replace("ё", "е")
    value = re.sub(r"[^a-zа-я0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def _is_year_text(value: object) -> bool:
    return bool(_YEAR_ONLY_RE.match(str(value or "").strip()))


def _month_number(word: str) -> Optional[int]:
    for stem, number in _MONTH_STEMS:
        if word.startswith(stem):
            return number
    return None


def _last_day(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def _parse_number(raw: object) -> Optional[float]:
    """Число из ячейки отчёта: пробелы-разделители, запятая, скобки."""
    text = str(raw or "").strip()
    if not text or text in {"-", "—", "–"}:
        return None
    negative = (
        text.startswith("(") or text.endswith(")")
        or text.startswith("-") or text.startswith("−")
    )
    text = (
        text.replace("(", "").replace(")", "")
        .replace("\u00a0", " ").replace("'", "").replace("’", "")
        .replace("−", "-").replace("–", "-")
        .replace(" ", "")
    )
    if "," in text and "." in text:
        text = text.replace(",", "")
    else:
        text = text.replace(",", ".")
    text = re.sub(r"[^0-9.]", "", text)
    if not text or text == ".":
        return None
    try:
        value = float(text)
    except ValueError:
        return None
    return -value if negative else value


def _unit_scale(units: object) -> Optional[float]:
    """Множитель для перевода денежных значений в млрд ₽.

    None — единицы не распознаны; тогда показываем число как в отчёте.
    """
    text = _norm(units)
    if not text:
        return None
    if re.search(r"миллиард|млрд|billion", text):
        return 1.0
    if re.search(r"миллион|млн|million", text):
        return 0.001
    if re.search(r"тысяч|тыс|thousand", text):
        return 1e-6
    return None


def _kind_from_text(text: str) -> Optional[str]:
    """Тип периода по словам «квартал / 6 месяцев / 9 месяцев / год».

    «девят\w*\s*мес» покрывает и «девять месяцев», и «девятимесячный»
    (в слитной форме пробела между корнем и «мес» нет).
    """
    value = _norm(text)
    if re.search(r"\b9\s*мес|девят\w*\s*мес", value):
        return "nine"
    if re.search(r"\b6\s*мес|шест\w*\s*мес|полугод", value):
        return "half"
    if re.search(r"\b3\s*мес|тр\w*\s*мес|квартал", value):
        return "quarter"
    if re.search(r"\b12\s*мес|двенадцат\w*\s*мес|\bгод\w*|annual", value):
        return "year"
    return None


def _quarter_from_text(text: str) -> Optional[int]:
    value = _norm(text)
    match = re.search(r"\b(i|ii|iii|iv)\s*квартал", value)
    if match:
        return _ROMAN_QUARTERS[match.group(1)]
    match = re.search(r"\b([1-4])\s*квартал", value)
    if match:
        return int(match.group(1))
    for stem, number in _WORD_QUARTERS.items():
        if re.search(rf"\b{stem}\w*\s*квартал", value):
            return number
    return None


def _extract_date(text: str) -> Optional[date]:
    """Дата из подписи периода: «30 июня 2026», «31.12.2025»."""
    normalized = _norm(text)
    match = _DATE_WORD_RE.search(normalized)
    if match:
        month = _month_number(match.group(2))
        if month:
            try:
                return date(int(match.group(3)), month, int(match.group(1)))
            except ValueError:
                return None
    match = _DATE_NUM_RE.search(str(text or ""))
    if match:
        day, month, year = (int(part) for part in match.groups())
        if year < 100:
            year += 2000
        try:
            return date(year, month, day)
        except ValueError:
            return None
    return None


@dataclass
class _Period:
    end: date
    kind: str
    quarter: Optional[int]
    label: str
    full_label: str

    @property
    def key(self) -> str:
        return f"{self.end.isoformat()}:{self.kind}"

    @property
    def sort(self) -> int:
        return self.end.year * 10000 + self.end.month * 100 + self.end.day


def _parse_period(raw_label: object, fallback_text: str = "") -> Optional[_Period]:
    """Нормализует подпись колонки в период (дата конца + тип).

    fallback_text — заголовок таблицы: в нём часто есть и дата, и тип
    периода, когда сама колонка называется просто «2025» или «Значение 1».
    """
    raw = str(raw_label or "").strip()
    label_text = _norm(raw)
    fallback = _norm(fallback_text)

    # Год колонки — последний год в подписи. Общая строка шапки («за …
    # 30 сентября 2026 г.») попадает в начало подписи каждой колонки,
    # а собственный год колонки («… 2025 г.») — в конец, поэтому первый
    # год верить нельзя.
    years = _YEAR_RE.findall(label_text) or _YEAR_RE.findall(fallback)
    if not years:
        return None
    year = int(years[-1])

    parsed_date = _extract_date(label_text)
    if parsed_date is None or parsed_date.year != year:
        fallback_date = _extract_date(fallback)
        if fallback_date is not None:
            if fallback_date.year == year:
                parsed_date = fallback_date
            elif parsed_date is None:
                # Сравнительная колонка («2025» рядом с «30 июня 2026»):
                # месяц и день берём из заголовка, год — из колонки.
                parsed_date = date(year, fallback_date.month, fallback_date.day)

    kind = _kind_from_text(label_text) or _kind_from_text(fallback)
    quarter = _quarter_from_text(label_text) or _quarter_from_text(fallback)
    month = parsed_date.month if parsed_date else None
    day = parsed_date.day if parsed_date else None

    if kind == "quarter":
        if quarter is None and month:
            quarter = (month - 1) // 3 + 1
        quarter = quarter or 1
        month = quarter * 3
        day = _last_day(year, month)
    elif kind == "half":
        combined = f"{label_text} {fallback}"
        if re.search(r"\b2\s*полугод|\bвтор\w*", combined):
            half = 2
        else:
            half = 2 if month and month > 6 else 1
        month = 6 if half == 1 else 12
        day = _last_day(year, month)
    elif kind == "nine":
        month, day = 9, 30
    elif kind == "year":
        month, day = 12, 31
    elif kind is None:
        # В балансе подписи — просто даты («30 июня 2026»); тип выводим
        # по месяцу, чтобы колонка склеилась с ОПиУ/ДДС того же периода.
        if parsed_date is None:
            kind = "year"
            month, day = 12, 31
        elif parsed_date.month == 12:
            kind = "year"
            month, day = 12, 31
        elif parsed_date.month == 9 and parsed_date.day >= 28:
            kind = "nine"
            month, day = 9, 30
        elif parsed_date.month == 6 and parsed_date.day >= 28:
            kind = "half"
            month, day = 6, 30
        elif parsed_date.month == 3 and parsed_date.day >= 28:
            kind = "quarter"
            quarter = 1
            month, day = 3, 31
        else:
            kind = "date"
            month, day = parsed_date.month, parsed_date.day

    end = date(year, month, day)
    if kind == "quarter":
        label = f"{year}Q{quarter}"
    elif kind == "half":
        label = f"{year} {'1п' if end.month == 6 else '2п'}"
    elif kind == "nine":
        label = f"{year} 9м"
    elif kind == "year":
        label = str(year)
    else:
        label = end.strftime("%d.%m.%Y")

    looks_auto = not label_text or label_text.startswith("значение")
    full_label = fallback_text.strip()[:140] if looks_auto and fallback_text else raw
    return _Period(end=end, kind=kind, quarter=quarter, label=label,
                   full_label=full_label or label)


def _table_columns(table: dict) -> list[tuple[int, str]]:
    """Индексы реальных колонок данных и их подписи.

    В некоторых PDF шапка не распознаётся, и колонки называются
    «Значение 1/2», а годы стоят в первой строке «Примечание». Такая
    строка одновременно является и заголовком периодов, и «мусорной»
    колонкой примечаний — по годам в ней и определяем данные.
    """
    names = list(table.get("columns") or [])[1:]
    rows = table.get("rows") or []

    year_row = None
    for row in rows:
        label = _norm(row.get("label"))
        cells = row.get("cells") or []
        if re.match(r"^(прим|note)", label) and any(_is_year_text(c) for c in cells):
            year_row = row
            break

    result: list[tuple[int, str]] = []
    for index, name in enumerate(names):
        name = str(name or "").strip()
        name_has_year = bool(_YEAR_RE.search(name))
        year_cell = None
        if year_row is not None:
            cells = year_row.get("cells") or []
            year_cell = cells[index] if index < len(cells) else None

        # Если строка «Примечание» есть, она авторитетнее названия колонки:
        # там, где нет года, стоит номер примечания, а не данные.
        if year_row is not None and not _is_year_text(year_cell) and not name_has_year:
            continue
        label = name if name_has_year or not _is_year_text(year_cell) else str(year_cell)
        if re.match(r"^(прим|стр)", _norm(label)):
            continue
        if not label:
            continue
        result.append((index, label))
    return result


def _match_priority(metric: MetricDef, label: str) -> Optional[int]:
    value = _norm(label)
    for priority, pattern in enumerate(metric.patterns):
        if re.search(pattern, value):
            return priority
    return None


def _wrap_value(number: float, metric: MetricDef,
                scale: Optional[float]) -> Optional[dict]:
    if metric.absolute:
        number = abs(number)
    if metric.unit == UNIT_MONEY:
        if scale is None:
            return {"v": round(number, 6), "u": "raw"}
        return {"v": round(number * scale, 6), "u": "bn"}
    if metric.unit == UNIT_PER_SHARE:
        return {"v": round(number, 6), "u": "share"}
    if metric.unit == UNIT_PERCENT:
        return {"v": round(number, 6), "u": "pct"}
    if metric.unit == UNIT_RATIO:
        return {"v": round(number, 6), "u": "x"}
    return None


def _choose_candidate(candidates: list[dict], combine: str) -> Optional[dict]:
    if not candidates:
        return None
    if combine == "sum":
        totals = [
            item for item in candidates
            if re.search(r"\bитого\b|\btotal\b", _norm(item["label"]))
        ]
        if totals:
            candidates = totals
        else:
            currencies = {item["value"]["u"] for item in candidates}
            if len(currencies) == 1:
                total = sum(item["value"]["v"] for item in candidates)
                return {
                    "label": " + ".join(item["label"] for item in candidates),
                    "value": {"v": round(total, 6),
                              "u": candidates[0]["value"]["u"]},
                }
    return min(candidates, key=lambda item: (
        item["priority"], item["indent"], item["order"],
    ))


def _collect_metrics(rows: list[dict], column_index: int, source: str,
                     scale: Optional[float], values: dict) -> None:
    """Собирает показатели одной колонки из строк таблицы."""
    candidates: dict[str, list[dict]] = {}
    for order, row in enumerate(rows):
        if row.get("section"):
            continue
        label = str(row.get("label") or "")
        if re.match(r"^(прим|стр)", _norm(label)):
            continue
        cells = row.get("cells") or []
        if column_index >= len(cells):
            continue
        raw = cells[column_index]
        if raw is None or not str(raw).strip():
            continue
        number = _parse_number(raw)
        if number is None:
            continue
        for metric in PARSING_METRICS:
            # source "any" — мультипликаторы/рентабельность ищем в любой
            # из распознанных таблиц.
            if metric.source != source and metric.source != "any":
                continue
            priority = _match_priority(metric, label)
            if priority is None:
                continue
            value = _wrap_value(number, metric, scale)
            if value is None:
                continue
            candidates.setdefault(metric.key, []).append({
                "priority": priority,
                "indent": int(row.get("indent") or 0),
                "order": order,
                "label": label,
                "value": value,
            })
            break

    source_priority = _SOURCE_PRIORITY.get(source, 9)
    for key, items in candidates.items():
        chosen = _choose_candidate(items, PARSING_BY_KEY[key].combine)
        if not chosen:
            continue
        existing = values.get(key)
        if existing and existing.get("_p", 9) <= source_priority:
            continue
        values[key] = {
            "v": chosen["value"]["v"],
            "u": chosen["value"]["u"],
            "_p": source_priority,
        }


def _new_column(period: _Period) -> dict:
    return {
        "key": period.key,
        "label": period.label,
        "full_label": period.full_label,
        "kind": period.kind,
        "year": period.end.year,
        "quarter": period.quarter,
        "end": period.end.isoformat(),
        "sort": period.sort,
        "values": {},
    }


def _same_unit(left: Optional[dict], right: Optional[dict]) -> bool:
    return bool(left and right and left.get("u") == right.get("u"))


def _annual_factor(kind: object) -> float:
    """Множитель приведения потока за период к году (как на smart-lab)."""
    return {
        "quarter": 4.0,
        "half": 2.0,
        "nine": 4.0 / 3.0,
    }.get(str(kind or ""), 1.0)


def _derive_column(values: dict, kind: str = "") -> None:
    """Производные показатели — только если есть исходные данные."""
    revenue = values.get("revenue")
    operating = values.get("operating_profit")
    amortization = values.get("amortization")
    net_profit = values.get("net_profit")
    cash_flow = values.get("operating_cash_flow")
    capex = values.get("capex")
    debt = values.get("debt")
    cash = values.get("cash")

    ebitda = values.get("ebitda")
    if ebitda is None and _same_unit(operating, amortization):
        ebitda = {
            "v": round(operating["v"] + amortization["v"], 6),
            "u": operating["u"],
        }
        values["ebitda"] = ebitda

    if cash_flow and capex and _same_unit(cash_flow, capex):
        values["fcf"] = {
            "v": round(cash_flow["v"] - abs(capex["v"]), 6),
            "u": cash_flow["u"],
        }

    if debt and cash and _same_unit(debt, cash):
        values["net_debt"] = {
            "v": round(debt["v"] - cash["v"], 6),
            "u": debt["u"],
        }

    if ebitda and revenue and _same_unit(ebitda, revenue) and revenue["v"]:
        values["ebitda_margin"] = {
            "v": round(ebitda["v"] / revenue["v"] * 100, 4), "u": "pct",
        }
    if net_profit and revenue and _same_unit(net_profit, revenue) and revenue["v"]:
        values["net_margin"] = {
            "v": round(net_profit["v"] / revenue["v"] * 100, 4), "u": "pct",
        }
    if debt and ebitda and _same_unit(debt, ebitda) and ebitda["v"]:
        values["debt_ebitda"] = {
            "v": round(debt["v"] / ebitda["v"], 4), "u": "x",
        }

    # Банковский шаблон: рентабельности считаем только из статей одной
    # единицы (млрд ₽ / как в отчёте) и не затираем значение, если строка
    # ROE/ROA/NIM/CIR была в самом отчёте. ROE/ROA/NIM — годовые
    # (поток за период приведён к году, как на smart-lab).
    shareholders = values.get("net_profit_shareholders")
    net_total = values.get("net_profit_total") or net_profit
    nii = values.get("net_interest_income")
    opex = values.get("operating_expenses")
    noi = values.get("net_operating_income")
    if noi is None:
        # Нет строки «Чистый операционный доход» (сжатые ОПиУ) — оценка
        # до резервов: операционные доходы (после резервов) + резервы +
        # чистый доход по небанковской деятельности.
        operating_income = values.get("operating_income_total")
        nonbank = values.get("nonbank_net_income")
        parts = [operating_income, values.get("provisions"), nonbank]
        if (
            operating_income
            and all(_same_unit(operating_income, part) for part in parts[1:])
        ):
            noi = {
                "v": round(sum(part["v"] for part in parts if part), 6),
                "u": operating_income["u"],
            }
            values["net_operating_income"] = noi
    assets = values.get("total_assets")
    equity = values.get("equity")
    factor = _annual_factor(kind)
    derived_bank = (
        # ROE/ROA/NIM — поток к запасу: годовые (фактор по типу периода).
        ("roe", shareholders, equity, factor),
        ("roa", net_total, assets, factor),
        ("nim", nii, assets, factor),
        # CIR — отношение двух потоков одного периода, множитель
        # сокращается.
        ("cir", opex, noi, 1.0),
    )
    for key, numerator, denominator, ratio_factor in derived_bank:
        if key in values:
            continue
        if (
            numerator and denominator
            and _same_unit(numerator, denominator)
            and denominator["v"]
        ):
            values[key] = {
                "v": round(
                    numerator["v"] / denominator["v"] * 100 * ratio_factor,
                    4,
                ),
                "u": "pct",
            }


def _finalize_column(column: dict) -> dict:
    _derive_column(column["values"], str(column.get("kind") or ""))
    column["values"] = {
        key: {"v": value["v"], "u": value["u"]}
        for key, value in column["values"].items()
    }
    return column


def build_columns(tables: list[dict]) -> list[dict]:
    """Собирает периоды одного документа из распознанных таблиц.

    Возвращает список колонок по возрастанию даты; у каждой — метаданные
    периода и значения показателей. Колонки ОПиУ/ДДС создают период,
    баланс приклеивается к периоду с той же датой (или создаёт колонку,
    если в документе только баланс).
    """
    periods: dict[str, dict] = {}
    balance_tables: list[dict] = []

    for table in tables:
        key = table.get("key")
        if key == "balance":
            balance_tables.append(table)
            continue
        # В сжатой отчётности банков ОПиУ объединён с отчётом о совокупном
        # доходе — статьи ОПиУ лежат в таблице «comprehensive».
        if key not in ("income", "cashflow", "comprehensive"):
            continue
        collect_source = "income" if key == "comprehensive" else key
        scale = _unit_scale(table.get("units"))
        rows = table.get("rows") or []
        raw_title = str(table.get("raw_title") or table.get("title") or "")
        for index, label in _table_columns(table):
            period = _parse_period(label, raw_title)
            if period is None:
                continue
            column = periods.get(period.key)
            if column is None:
                column = _new_column(period)
                periods[period.key] = column
            _collect_metrics(rows, index, collect_source, scale, column["values"])

    for table in balance_tables:
        scale = _unit_scale(table.get("units"))
        rows = table.get("rows") or []
        raw_title = str(table.get("raw_title") or table.get("title") or "")
        for index, label in _table_columns(table):
            period = _parse_period(label, raw_title)
            if period is None:
                continue
            targets = [
                column for column in periods.values()
                if column["end"] == period.end.isoformat()
            ]
            if not targets:
                column = periods.get(period.key)
                if column is None:
                    column = _new_column(period)
                    periods[period.key] = column
                targets = [column]
            for column in targets:
                _collect_metrics(rows, index, "balance", scale, column["values"])

    return [
        _finalize_column(periods[key])
        for key in sorted(periods, key=lambda item: (
            periods[item]["sort"], periods[item]["kind"],
        ))
    ]


# =============================================================================
# КОМПАНИИ ИЗ WATCHLIST
# =============================================================================

_CRYPTO_SUFFIX_RE = re.compile(
    r"^[A-Z0-9]{2,15}(?:USDT|USDC|BUSD|FDUSD|TUSD)$"
)


def canonical_symbol(raw: object) -> Optional[str]:
    """Приводит тикер watchlist к виду MOEX:<код>; крипту отбрасывает."""
    value = str(raw or "").strip().upper()
    if not value or value.startswith("SECTION:"):
        return None
    if value.startswith("BINANCE:"):
        return None
    if value.startswith("MOEX:"):
        code = value[5:].strip()
        return f"MOEX:{code}" if code else None
    if ":" in value:
        # Другие площадки в отчётности не поддерживаются.
        return None
    if _CRYPTO_SUFFIX_RE.match(value):
        return None
    return f"MOEX:{value}"


def _bare_ticker(symbol: str) -> str:
    return symbol.split(":", 1)[1] if ":" in symbol else symbol


def _load_columns(raw: object) -> list[dict]:
    try:
        columns = json.loads(raw or "[]")
    except (TypeError, ValueError):
        return []
    return columns if isinstance(columns, list) else []


def _document_stats() -> tuple[dict[str, dict], int]:
    """Количество документов и уникальных периодов по тикерам + «сироты».

    Периоды считаем по ключам (дата+тип), а не по сумме колонок файлов:
    один и тот же год может прийти и из годового отчёта, и из баланса
    полугодового — в таблице это одна колонка.
    """
    stats: dict[str, dict] = {}
    orphans = 0
    with get_session() as db:
        rows = db.query(
            ReportDocument.ticker, ReportDocument.columns_json,
        ).all()
    for ticker, columns_json in rows:
        if not ticker:
            orphans += 1
            continue
        entry = stats.setdefault(ticker, {"documents": 0, "periods": set()})
        entry["documents"] += 1
        for column in _load_columns(columns_json):
            key = str(column.get("key") or "")
            if key:
                entry["periods"].add(key)
    return {
        ticker: {
            "documents": entry["documents"],
            "periods": len(entry["periods"]),
        }
        for ticker, entry in stats.items()
    }, orphans


def list_companies() -> dict:
    """Бумаги watchlist (без crypto) + компании, по которым уже есть отчёты."""
    stats, orphans = _document_stats()
    companies: list[dict] = []
    seen: set[str] = set()

    with get_session() as db:
        rows = (
            db.query(WatchlistItem)
            .order_by(
                WatchlistItem.list_id.asc(),
                WatchlistItem.position.asc(),
                WatchlistItem.id.asc(),
            )
            .all()
        )
    for row in rows:
        symbol = canonical_symbol(row.symbol)
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        entry = stats.get(symbol, {})
        companies.append({
            "ticker": symbol,
            "code": _bare_ticker(symbol),
            "exchange": "MOEX",
            "sector": sector_for_symbol(symbol),
            "documents": entry.get("documents", 0),
            "periods": entry.get("periods", 0),
            "in_watchlist": True,
        })

    # Отчёты, загруженные до появления привязки к компании или по бумаге,
    # которую потом убрали из watchlist, не должны «пропасть» из раздела.
    for symbol, entry in sorted(stats.items()):
        if symbol in seen:
            continue
        seen.add(symbol)
        companies.append({
            "ticker": symbol,
            "code": _bare_ticker(symbol),
            "exchange": "MOEX",
            "sector": sector_for_symbol(symbol),
            "documents": entry["documents"],
            "periods": entry["periods"],
            "in_watchlist": False,
        })

    if orphans:
        companies.append({
            "ticker": "__orphans__",
            "code": "Без компании",
            "exchange": "",
            "sector": SECTOR_DEFAULT,
            "documents": orphans,
            "periods": 0,
            "in_watchlist": False,
        })

    return {"companies": companies, "total": len(companies)}


# =============================================================================
# ФИНАНСОВАЯ ТАБЛИЦА КОМПАНИИ
# =============================================================================

def metrics_catalog(sector: str = SECTOR_DEFAULT) -> list[dict]:
    """Строки таблицы по сектору: банковский шаблон или общий каталог."""
    if sector == SECTOR_BANK:
        defs = [PARSING_BY_KEY[key] for key in BANK_TEMPLATE]
    else:
        defs = METRICS
    return [
        {
            "key": metric.key,
            "label": metric.label,
            "unit": metric.unit,
            "group": metric.group,
            "group_label": GROUP_LABELS.get(metric.group, ""),
            "core": metric.core,
            "derived": metric.derived,
            "hint": metric.hint,
        }
        for metric in defs
    ]


def _document_public(row: ReportDocument, columns: list[dict]) -> dict:
    return {
        "id": row.id,
        "filename": row.filename,
        "period": row.period or "",
        "pages": row.pages or 0,
        "ticker": row.ticker or "",
        "column_count": len(columns),
        "period_labels": [str(column.get("label") or "") for column in columns],
        "uploaded_at": (row.uploaded_at.isoformat() + "Z") if row.uploaded_at else "",
    }


def company_financials(ticker: str) -> Optional[dict]:
    """Колонки периодов и документы выбранной компании.

    None — тикер не похож на бумагу Мосбиржи (например, крипта).
    """
    raw = str(ticker or "").strip()
    orphan_mode = raw == "__orphans__"
    symbol = None if orphan_mode else canonical_symbol(raw)
    if not orphan_mode and not symbol:
        return None

    with get_session() as db:
        query = db.query(ReportDocument)
        if orphan_mode:
            query = query.filter(ReportDocument.ticker.is_(None))
        else:
            query = query.filter(ReportDocument.ticker == symbol)
        rows = query.order_by(ReportDocument.id.asc()).all()

    columns: dict[str, dict] = {}
    documents: list[dict] = []
    for row in rows:
        document_columns = _load_columns(row.columns_json)
        documents.append(_document_public(row, document_columns))
        for column in document_columns:
            key = str(column.get("key") or "")
            if not key:
                continue
            existing = columns.get(key)
            if existing is None:
                columns[key] = dict(column)
                continue
            # Более поздняя загрузка уточняет значения, но не стирает
            # показатели, которых в новом файле нет.
            merged = dict(existing)
            merged.update({
                field: column.get(field)
                for field in ("label", "full_label", "kind", "year",
                              "quarter", "end", "sort")
                if column.get(field) is not None
            })
            merged_values = dict(existing.get("values") or {})
            merged_values.update(column.get("values") or {})
            merged["values"] = merged_values
            columns[key] = merged

    ordered = sorted(
        columns.values(),
        key=lambda column: (
            int(column.get("sort") or 0), str(column.get("kind") or ""),
        ),
        reverse=True,
    )
    documents.reverse()  # в интерфейсе новые загрузки сверху

    # Сектор: сначала по тикеру, при отсутствии в списке — по содержимому
    # отчета (ЧПД в колонках значит банковский отчет).
    sector = sector_for_columns(symbol, ordered)

    return {
        "ticker": symbol or "__orphans__",
        "code": "Без компании" if orphan_mode else _bare_ticker(symbol),
        "exchange": "" if orphan_mode else "MOEX",
        "sector": sector,
        "columns": ordered,
        "metrics": metrics_catalog(sector),
        "documents": documents,
        "has_columns": bool(ordered),
    }
