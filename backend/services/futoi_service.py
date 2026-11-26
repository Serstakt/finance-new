"""FUTOI — открытые позиции по фьючерсам в разрезе физ. и юр. лиц.

Данные MOEX ISS+ / Algopack:
  * GET /iss/analyticalproducts/futoi/securities.json — снимок по всем
    инструментам (последняя доступная дата, для списка инструментов);
  * GET /iss/analyticalproducts/futoi/securities/{ticker}.json — история
    одного инструмента. С параметром latest=1 ISS отдаёт по одной записи
    на торговый день (последний снимок ~23:50), поэтому для дневного графика
    достаточно одной страницы на ~500 дней (лимит ISS — 1000 строк).

Аналог smart-lab.ru/oi (например /oi/MX): ISS отдаёт позиции по корню
инструмента в разрезе всех серий (MX — все фьючерсы на индекс МосБиржи),
сгруппированные по физлицам (FIZ) и юрлицам (YUR) с шагом ~5 минут.
Сервис сворачивает внутридневные снимки в дневной ряд, чтобы фронтенд
рисовал линейный график.

Авторизация — тот же Bearer-токен MOEX_API_TOKEN, что у котировок
(см. moex_service): с токеном запросы идут на apim.moex.com, без него —
на анонимный iss.moex.com. Бесплатный тариф ISS+ отдаёт FUTOI с задержкой
14 дней, поэтому диапазон автоматически укорачивается по дате из ответа
(«Free users can't receive data for the last 14 days (YYYY-MM-DD)»), а в
ответе ставится delayed=True.
"""
import asyncio
import re
import time
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import aiohttp

from backend.services.moex_service import get_moex_token

APIM_HOST = "https://apim.moex.com"
ISS_HOST = "https://iss.moex.com"
FUTOI_PATH = "/iss/analyticalproducts/futoi/securities"

# Лимит строк в одном блоке ISS — 1000. При latest=1 это ~500 торговых дней
# (по две строки на день: FIZ + YUR).
PAGE_SIZE = 1000

# Страховка от бесконечной пагинации: 3000 календарных дней ≈ с 2018 года,
# а сам датасет FUTOI начинается с 2020-01-03.
MAX_DAYS = 3000
MAX_PAGES = 12

# Кэш дневных рядов: FUTOI обновляется на стороне ISS каждые 5 минут,
# поэтому чаще опрашивать источник смысла нет.
CACHE_TTL_SECONDS = 300.0
# Справочник инструментов/названий меняется редко.
INSTRUMENTS_TTL_SECONDS = 3600.0

# Поля позиций в ответе ISS (см. /docs/description/futoi Algopack).
GROUP_FIELDS = (
    "pos", "pos_long", "pos_short", "pos_long_num", "pos_short_num",
)

# Читаемые подписи популярных инструментов: «КОД · Название». Остальные
# получают короткое имя из справочника срочного рынка (SHORTNAME базовой
# серии, например «AFLT»), а если и его нет — сам код FUTOI.
INSTRUMENT_LABELS = {
    "MX": "MIX · Индекс МосБиржи",
    "MM": "MXI · Мини-индекс МосБиржи",
    "RI": "RTS · Индекс РТС",
    "RM": "RTSM · Мини-индекс РТС",
    "IMOEXF": "IMOEXF · Индекс МосБиржи (вечный)",
    "Si": "Si · Доллар/рубль",
    "CR": "CNY · Юань/рубль",
    "EU": "Eu · Евро/рубль",
    "Eu": "Eu · Евро/рубль",
    "ED": "ED · Евро/доллар",
    "UC": "UCNY · Юань (UC)",
    "MY": "MOEXCNY · Юань МосБиржи",
    "USDRUBF": "USDRUBF · Доллар/рубль (вечный)",
    "EURRUBF": "EURRUBF · Евро/рубль (вечный)",
    "CNYRUBF": "CNYRUBF · Юань/рубль (вечный)",
    "GLDRUBF": "GLDRUBF · Золото/рубль",
    "BR": "BR · Нефть Brent",
    "NG": "NG · Природный газ",
    "GD": "GOLD · Золото",
    "GL": "GL · Золото",
    "SV": "SILV · Серебро",
    "PT": "PLT · Платина",
    "PD": "PLD · Палладий",
    "CE": "COPPER · Медь",
    "GZ": "GAZR · Газпром",
    "LK": "LKOH · ЛУКОЙЛ",
    "SR": "SBRF · Сбербанк",
    "SP": "SBPR · Сбербанк-п",
    "TT": "TATN · Татнефть",
    "RN": "ROSN · Роснефть",
    "SN": "SNGR · Сургутнефтегаз",
    "VB": "VTBR · ВТБ",
    "ME": "MOEX · Акции МосБиржи",
    "AF": "AFLT · Аэрофлот",
    "AL": "ALRS · АЛРОСА",
    "GK": "GMKN · ГМК Норникель",
    "HY": "HYDR · РусГидро",
    "NM": "NLMK · НЛМК",
    "RL": "RUAL · РУСАЛ",
    "MG": "MAGN · ММК",
    "MN": "MGNT · Магнит",
    "MT": "MTSI · МТС",
    "ON": "OZON · Ozon",
    "VK": "VKCO · VK",
    "YD": "YDEX · Яндекс",
    "X5": "X5 · X5 Group",
    "SF": "SPYF · S&P 500",
    "NA": "NASD · NASDAQ",
    "DX": "DAX · DAX",
    "HS": "HANG · Hang Seng",
    "BT": "BTC · Bitcoin",
    "EH": "ETH · Ethereum",
}

# Кэш дневных рядов: (ticker, days) -> (monotonic_ts, ответ).
_series_cache: dict[tuple[str, int], tuple[float, dict]] = {}
# Кэш справочника: {"ts": monotonic, "names": {ticker: name}, "tickers": [...]}.
_instruments_cache: dict[str, object] = {}
_names_cache: dict[str, object] = {}
# Блокировки на ключ — параллельные запросы одного тикера не дублируют
# многократную пагинацию истории.
_locks: dict[tuple[str, int], asyncio.Lock] = {}


def clear_cache() -> None:
    """Сброс кэшей (тесты; в проде записи истекают сами по TTL)."""
    _series_cache.clear()
    _instruments_cache.clear()
    _names_cache.clear()
    _locks.clear()


def _msk_today() -> date:
    """Текущая дата по Москве — по ней считается окно истории."""
    return (datetime.now(timezone.utc) + timedelta(hours=3)).date()


async def _get_json(url: str, headers: dict, timeout: float = 30.0) -> dict:
    """GET -> dict; при сетевой ошибке/не-200 возвращает {'error': ...}."""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=timeout)) as session:
        try:
            async with session.get(url, headers=headers) as response:
                if response.status != 200:
                    return {"error": f"Not found (Status {response.status})"}
                return await response.json()
        except asyncio.TimeoutError:
            return {"error": "Timeout"}
        except Exception as e:  # noqa: BLE001 — единый формат ошибки для API
            return {"error": str(e)}


def _col(columns: list, row: list, name: str):
    """Значение колонки по имени (None, если колонки нет)."""
    try:
        return row[columns.index(name)]
    except (ValueError, IndexError):
        return None


def _as_int(value) -> Optional[int]:
    """ISS может отдать число строкой/None — приводим к int."""
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_error_limit(message: str) -> Optional[str]:
    """Достаёт допустимую дату из ответа «Free users can't receive data…».

    ISS+ на бесплатном тарифе отдаёт FUTOI с задержкой 14 дней и на запрос
    свежих дат отвечает ERROR_MESSAGE с последней разрешённой датой:
    «Invalid date. Free users can't receive data for the last 14 days
    (2026-11-12).» Возвращает 'YYYY-MM-DD' или None.
    """
    m = re.search(r"(\d{4}-\d{2}-\d{2})", message or "")
    return m.group(1) if m else None


def aggregate_daily(columns: list, rows: list) -> list[dict]:
    """Сворачивает внутридневные снимки ISS в дневной ряд.

    rows — строки блока futoi (порядок обычно по убыванию времени). Для
    каждой пары (tradedate, clgroup) остаётся запись с самым поздним
    tradetime — это итог торгового дня, как в таблице smart-lab.
    Возвращает список по возрастанию даты:
    [{date, fiz: {...}|None, yur: {...}|None, total: {...}}].
    """
    by_date: dict[str, dict[str, dict]] = {}
    for row in rows or []:
        trade_date = _col(columns, row, "tradedate")
        group = (_col(columns, row, "clgroup") or "").upper()
        if not trade_date or group not in ("FIZ", "YUR"):
            continue
        trade_time = str(_col(columns, row, "tradetime") or "")
        day = by_date.setdefault(str(trade_date), {})
        prev = day.get(group)
        # Более поздний снимок дня побеждает (сравнение строк HH:MM:SS).
        if prev is not None and str(prev.get("_time") or "") > trade_time:
            continue
        entry = {field: _as_int(_col(columns, row, field)) for field in GROUP_FIELDS}
        entry["_time"] = trade_time
        # Время публикации снимка пригодится фронтенду в подписи «на …».
        entry["systime"] = _col(columns, row, "systime")
        day[group] = entry

    out: list[dict] = []
    for trade_date in sorted(by_date):
        day = by_date[trade_date]
        fiz = day.get("FIZ")
        yur = day.get("YUR")

        def clean(group: Optional[dict]) -> Optional[dict]:
            if group is None:
                return None
            return {k: v for k, v in group.items() if k != "_time"}

        total = {}
        for field in GROUP_FIELDS:
            values = [g.get(field) for g in (fiz, yur) if g and g.get(field) is not None]
            total[field] = sum(values) if values else None
        times = [g.get("systime") for g in (fiz, yur) if g and g.get("systime")]
        out.append({
            "date": trade_date,
            "fiz": clean(fiz),
            "yur": clean(yur),
            "total": total,
            "systime": max(times) if times else None,
        })
    return out


def _headers() -> tuple[dict, bool]:
    """Заголовки авторизации и признак «идём на apim.moex.com»."""
    token = get_moex_token()
    return ({"Authorization": f"Bearer {token}"} if token else {}), bool(token)


async def _fetch_page(ticker: str, from_date: str, till_date: str,
                      latest: bool = True) -> dict:
    """Одна страница истории FUTOI по инструменту.

    С токеном — apim.moex.com (данные без задержки 15 минут), при сетевой
    ошибке/401 — откат на анонимный iss.moex.com. Ограничение бесплатного
    тарифа (14 дней) возвращается как {'error': …} с исходным сообщением ISS.
    """
    headers, use_apim = _headers()

    async def request(host: str, host_headers: dict) -> dict:
        url = f"{host}{FUTOI_PATH}/{ticker}.json"
        params = f"?iss.meta=off&from={from_date}&till={till_date}"
        if latest:
            params += "&latest=1"
        return await _get_json(url + params, host_headers)

    data = await request(APIM_HOST if use_apim else ISS_HOST, headers)
    if use_apim and "error" in data:
        # Сетевая ошибка/401 на apim — откат на анонимный ISS. Содержательный
        # ERROR_MESSAGE (ограничение бесплатного тарифа) не повод для отката:
        # анонимный ISS вернёт ровно то же самое.
        data = await request(ISS_HOST, {})
    return data


def _error_message(data: dict) -> Optional[str]:
    """Текст ERROR_MESSAGE из блока futoi (ISS отвечает 200 с ошибкой)."""
    block = data.get("futoi") or {}
    columns = block.get("columns") or []
    if "ERROR_MESSAGE" not in columns:
        return None
    rows = block.get("data") or []
    if not rows:
        return None
    try:
        return str(rows[0][columns.index("ERROR_MESSAGE")])
    except (ValueError, IndexError):
        return None


async def _fetch_daily_rows(ticker: str, from_date: date, till_date: date) -> dict:
    """Собирает дневные снимки за диапазон с пагинацией по 1000 строк.

    ISS отдаёт страницы от свежих дат к старым; при заполненной странице
    продолжаем со следующего дня перед самой старой полученной датой.
    Возвращает {'rows': [...], 'columns': [...], 'delayed': bool,
    'till': actual_till, 'dataset_from': ...} или {'error': ...}.
    """
    columns: Optional[list] = None
    collected: list = []
    cursor_till = till_date
    delayed = False
    actual_till = till_date

    for _ in range(MAX_PAGES):
        data = await _fetch_page(ticker, from_date.isoformat(), cursor_till.isoformat())
        if "error" in data:
            return {"error": data["error"]}

        error_message = _error_message(data)
        if error_message:
            limit = parse_error_limit(error_message)
            # Бесплатный тариф: укорачиваем диапазон до разрешённой даты
            # и повторяем один раз (затем пагинация идёт уже от неё).
            if limit and not delayed:
                try:
                    cursor_till = min(cursor_till, date.fromisoformat(limit))
                except ValueError:
                    return {"error": error_message}
                delayed = True
                actual_till = cursor_till
                # Окно могло сдвинуться за пределы разрешённой даты (запрос
                # «последние N дней» на бесплатном тарифе) — оставляем хотя бы
                # неделю истории перед ограничением.
                if from_date > cursor_till:
                    from_date = cursor_till - timedelta(days=7)
                continue
            return {"error": error_message}

        block = data.get("futoi") or {}
        page_columns = block.get("columns") or []
        page_rows = block.get("data") or []
        if columns is None:
            columns = page_columns
        collected.extend(page_rows)

        if len(page_rows) < PAGE_SIZE:
            break

        date_values = []
        for row in page_rows:
            raw = _col(page_columns, row, "tradedate")
            if raw:
                date_values.append(str(raw))
        if not date_values:
            break
        oldest = date.fromisoformat(min(date_values))
        if oldest <= from_date:
            break
        cursor_till = oldest - timedelta(days=1)

    if columns is None:
        return {"error": "No data"}

    dates_block = (data.get("futoi.dates") or {}).get("data") or []
    dataset_from = dates_block[0][0] if dates_block and dates_block[0] else None
    return {
        "columns": columns,
        "rows": collected,
        "delayed": delayed,
        "till": actual_till.isoformat(),
        "dataset_from": dataset_from,
    }


async def _fetch_futures_names() -> dict[str, str]:
    """Справочник кодов FUTOI -> короткое имя серии (SHORTNAME базовой серии).

    FUTOI использует префикс SECID срочного рынка (MX у MXH7, SI у SiH7),
    поэтому из каждого SECID отбрасываем месяц/год (2 символа) и берём
    базовое имя «MIX-3.27» -> «MIX». Полные/вечные тикеры (CNYRUBF) маппятся
    по самому SECID. Справочник кэшируется на час.
    """
    now = time.monotonic()
    cached = _names_cache.get("names")
    if cached is not None and now - float(_names_cache.get("ts") or 0) < INSTRUMENTS_TTL_SECONDS:
        return cached  # type: ignore[return-value]

    url = (f"{ISS_HOST}/iss/engines/futures/markets/forts/securities.json"
           f"?iss.meta=off&iss.only=securities"
           f"&securities.columns=SECID,SHORTNAME,ASSETCODE")
    data = await _get_json(url, {}, timeout=20.0)
    block = data.get("securities") or {}
    columns = block.get("columns") or []
    rows = block.get("data") or []
    names: dict[str, str] = {}
    for row in rows:
        secid = str(_col(columns, row, "SECID") or "").strip()
        shortname = str(_col(columns, row, "SHORTNAME") or "").strip()
        if not secid or not shortname:
            continue
        base = shortname.split("-")[0].strip()
        if len(secid) > 2:
            names.setdefault(secid[:-2], base)
        names.setdefault(secid, base)
        asset = str(_col(columns, row, "ASSETCODE") or "").strip()
        if asset:
            names.setdefault(asset, base)
    if names:
        _names_cache["names"] = names
        _names_cache["ts"] = now
    return names


def display_name(ticker: str, names: Optional[dict[str, str]] = None) -> str:
    """Подпись инструмента: читаемая для популярных, иначе «ИМЯ · КОД»."""
    ticker = str(ticker or "").strip()
    label = INSTRUMENT_LABELS.get(ticker)
    if label:
        return label
    base = (names or {}).get(ticker)
    if base and base.upper() != ticker.upper():
        return f"{base} · {ticker}"
    return ticker


async def fetch_instruments() -> dict:
    """Список инструментов FUTOI для селектора раздела.

    Берётся последний снимок по всем инструментам (latest=1) — он же
    показывает, на какую дату доступны данные (на бесплатном тарифе ISS+
    это ~14 дней назад, поэтому в ответе delayed/delay_days).
    """
    now = time.monotonic()
    cached = _instruments_cache.get("value")
    if cached and now - float(_instruments_cache.get("ts") or 0) < INSTRUMENTS_TTL_SECONDS:
        return cached  # type: ignore[return-value]

    headers, _ = _headers()
    data = await _get_json(f"{APIM_HOST if headers else ISS_HOST}"
                           f"{FUTOI_PATH}.json?iss.meta=off&latest=1", headers,
                           timeout=30.0)
    if "error" in data and headers:
        data = await _get_json(f"{ISS_HOST}{FUTOI_PATH}.json?iss.meta=off&latest=1", {},
                               timeout=30.0)

    tickers: list[str] = []
    latest_snapshot = None
    block = data.get("futoi") or {}
    columns = block.get("columns") or []
    rows = block.get("data") or []
    if "ERROR_MESSAGE" not in columns:
        for row in rows:
            ticker = _col(columns, row, "ticker")
            if ticker:
                tickers.append(str(ticker))
            systime = _col(columns, row, "systime")
            if isinstance(systime, str) and (latest_snapshot is None or systime > latest_snapshot):
                latest_snapshot = systime

    if not tickers:
        # Источник недоступен: отдаём популярные инструменты, чтобы раздел
        # не был пустым (история по ним запросится при выборе).
        tickers = ["MX", "RI", "Si", "CR", "BR", "NG", "GD", "SV", "PT", "GZ", "LK", "SR"]

    names = await _fetch_futures_names()
    unique = sorted(set(tickers))
    instruments = [{
        "ticker": t,
        "name": display_name(t, names),
        "short": (names.get(t) or t),
    } for t in unique]

    delay_days = None
    delayed = False
    if latest_snapshot:
        try:
            latest_date = date.fromisoformat(str(latest_snapshot)[:10])
            delay_days = max(0, (_msk_today() - latest_date).days)
            # 4 дня — запас на выходные/праздники, не считаем их задержкой.
            delayed = delay_days > 4
        except ValueError:
            pass

    result = {
        "instruments": instruments,
        "latest_snapshot": latest_snapshot,
        "delayed": delayed,
        "delay_days": delay_days,
        "source": "apim" if headers else "iss",
    }
    _instruments_cache["value"] = result
    _instruments_cache["ts"] = now
    return result


async def fetch_futoi_series(ticker: str, days: int = 365, force: bool = False) -> dict:
    """Дневной ряд открытых позиций по одному инструменту FUTOI.

    days — глубина истории (30/90/180/365 или 3000 = «всё»). Данные
    кэшируются на 5 минут; пагинация ISS (1000 строк ≈ 500 дней) собирает
    длинные диапазоны несколькими запросами. force=True (кнопка «Обновить»
    на фронтенде) игнорирует кэш и перечитывает источник.
    """
    ticker = str(ticker or "").strip()
    if not re.fullmatch(r"[A-Za-z0-9]{1,12}", ticker):
        raise ValueError("Некорректный код инструмента FUTOI")
    days = max(7, min(int(days), MAX_DAYS))

    key = (ticker, days)
    now = time.monotonic()
    if not force:
        cached = _series_cache.get(key)
        if cached and now - cached[0] < CACHE_TTL_SECONDS:
            return cached[1]

    lock = _locks.setdefault(key, asyncio.Lock())
    async with lock:
        # Пока ждали блокировку, параллельный запрос мог уже наполнить кэш.
        if not force:
            cached = _series_cache.get(key)
            if cached and time.monotonic() - cached[0] < CACHE_TTL_SECONDS:
                return cached[1]

        till = _msk_today()
        from_date = max(till - timedelta(days=days), date(2019, 1, 1))
        raw = await _fetch_daily_rows(ticker, from_date, till)
        if raw.get("error"):
            return {"ticker": ticker, "name": display_name(ticker), "error": raw["error"]}

        series = aggregate_daily(raw.get("columns") or [], raw.get("rows") or [])
        names = await _fetch_futures_names()
        latest = series[-1]["date"] if series else None
        delay_days = None
        if latest:
            try:
                delay_days = max(0, (_msk_today() - date.fromisoformat(latest)).days)
            except ValueError:
                pass

        result = {
            "ticker": ticker,
            "name": display_name(ticker, names),
            "days": days,
            "requested_from": from_date.isoformat(),
            "requested_till": _msk_today().isoformat(),
            # Фактический конец данных: у бесплатного тарифа он укорачивается
            # до «сегодня − 14 дней».
            "till": raw.get("till"),
            "latest": latest,
            "updated": series[-1].get("systime") if series else None,
            "delayed": bool(raw.get("delayed")) or bool(delay_days and delay_days > 4),
            "delay_days": delay_days,
            "dataset_from": raw.get("dataset_from"),
            "series": series,
        }
        if raw.get("delayed"):
            result["note"] = ("Бесплатный тариф MOEX API отдаёт FUTOI с задержкой "
                              "14 дней — данные доступны по последнюю разрешённую дату.")
        _series_cache[key] = (time.monotonic(), result)
        return result
