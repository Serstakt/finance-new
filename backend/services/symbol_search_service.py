"""
Поиск инструментов для автодополнения ввода тикеров (аналог поиска
TradingView: совпадения по тикеру и названию, тип актива в подсказке).

Источники:
  * MOEX ISS — /iss/securities.json?q=... (совпадения по SECID/SHORTNAME/NAME).
    В выдачу попадают только инструменты, цены которых терминал умеет
    запрашивать: акции доски TQBR (fetch_moex_price), валюты CETS и четыре
    известных индекса (IMOEX, RTSI, RGBI, IRUS). Облигации и прочие группы
    отфильтровываются — иначе подсказка гарантированно падала бы на
    валидации цены при добавлении.
  * Крипта — справочник пар Binance /api/v3/exchangeInfo (кэш на сутки):
    подсказка обязана быть реальной торгуемой парой, иначе по ней не
    построятся свечи (/api/v3/klines). Полное имя монеты и логотип
    добираются через общие кэши CoinGecko (crypto_service.resolve_coin_id +
    _fetch_markets) — после первой загрузки это вызовы только из памяти.

Формат ответа: {"results": [{symbol, ticker, name, type, exchange, logo}]}.
type: stock | currency | index | crypto — фронтенд рисует по нему бейдж.
"""
import asyncio
import time
from typing import Optional
from urllib.parse import quote

import aiohttp

from . import crypto_service
from . import moex_service

# Группы ISS, которые терминал умеет показывать (см. fetch_moex_price):
# акции — доска TQBR, валюты — CETS, индексы — только известный набор.
_MOEX_GROUPS = {"stock_shares", "currency_selt", "stock_index"}

# Индексы, поддерживаемые fetch_moex_price (там особый URL): остальные
# группы stock_index молча пропускаем — цена по ним не запросится.
_MOEX_INDICES = {
    "IMOEX": "Индекс МосБиржи",
    "RTSI": "Индекс РТС",
    "RGBI": "Индекс гособлигаций МосБиржи RGBI",
    "IRUS": "Индекс МосБиржи России",
}

# Приоритет котируемых активов Binance при дедупликации по базовой монете
# (BTC -> BTCUSDT, а не BTCUSDC/BTCBTC): первые — самые ликвидные.
_QUOTE_PRIORITY = ("USDT", "FDUSD", "USDC", "TUSD", "BUSD", "BTC", "ETH",
                   "TRY", "EUR", "BNB", "DAI")

# --- кэши -------------------------------------------------------------------
# Пары Binance: SYMBOL -> (baseAsset, quoteAsset). exchangeInfo весит ~17 МБ,
# поэтому тянется один раз в сутки и сразу прореживается до торгуемых пар.
_binance_pairs_cache: dict = {"ts": 0.0, "pairs": {}}
_BINANCE_INFO_TTL = 24 * 3600
_binance_info_lock = asyncio.Lock()


def _match_score(q: str, ticker: str, *names: Optional[str]) -> Optional[int]:
    """Релевантность совпадения запроса: 0 — точный тикер, 1 — начало тикера,
    2 — вхождение в тикер, 3 — начало названия, 4 — вхождение в название.
    None — запрос в тикере/названии не найден (ISS q ищет ещё и по ISIN/REGNUMBER
    — такие результаты показывать не нужно)."""
    t = (ticker or "").upper()
    if t == q:
        return 0
    if t.startswith(q):
        return 1
    if q in t:
        return 2
    for n in names:
        nu = (n or "").upper()
        if not nu:
            continue
        if nu.startswith(q):
            return 3
        if q in nu:
            return 4
    return None


def _get_col_index(columns: list, name: str) -> int:
    try:
        return columns.index(name)
    except ValueError:
        return -1


def _parse_moex_securities(data: dict, query: str) -> list[dict]:
    """Сырой ответ ISS -> отфильтрованные и оценённые подсказки MOEX."""
    sec = data.get("securities") or {}
    columns = sec.get("columns") or []
    rows = sec.get("data") or []

    i_sec = _get_col_index(columns, "secid")
    i_short = _get_col_index(columns, "shortname")
    i_name = _get_col_index(columns, "name")
    i_group = _get_col_index(columns, "group")
    i_traded = _get_col_index(columns, "is_traded")
    i_primary = _get_col_index(columns, "primary_boardid")
    i_market_board = _get_col_index(columns, "marketprice_boardid")
    # columns пустые = ответ не той формы (ошибка ISS) — выходим; ПУСТОЙ rows
    # — валидный ответ без совпадений: ниже по строкам ещё добавятся
    # статические индексы (IMOEX и др. в ISS-поиске отсутствуют)
    if i_sec < 0 or not columns:
        return []

    q = query.upper()
    out: list[dict] = []
    seen: set[str] = set()
    for row in rows:
        secid = str(row[i_sec] or "").strip().upper()
        if not secid or secid in seen:
            continue
        group = str(row[i_group]) if i_group >= 0 and row[i_group] is not None else ""
        if group not in _MOEX_GROUPS:
            continue
        # is_traded может быть None у инструментов без торгов — берём только 1
        if i_traded >= 0 and row[i_traded] == 0:
            continue

        # Известные индексы ISS-поиском не находятся — их добавляем отдельным
        # статическим списком ниже; прочие индексы пропускаем (цены не взять).
        if group == "stock_index":
            continue
        if group == "stock_shares":
            market_board = str(row[i_market_board]) if i_market_board >= 0 and row[i_market_board] is not None else ""
            if market_board != "TQBR":
                continue
        if group == "currency_selt":
            primary_board = str(row[i_primary]) if i_primary >= 0 and row[i_primary] is not None else ""
            if primary_board != "CETS":
                continue
            # Цену валюты fetch_moex_price берёт из ветки CETS только при
            # 'RUB' в тикере или явных USD000UTSTOM/EUR_RUB__TOM: прочие
            # валютные коды (TOD/TOM/AED-варианты) ушли бы в акции TQBR и
            # гарантированно упали на валидации цены — не подсказываем.
            if "RUB" not in secid and secid not in ("USD000UTSTOM", "EUR_RUB__TOM"):
                continue

        shortname = str(row[i_short]).strip() if i_short >= 0 and row[i_short] else ""
        fullname = str(row[i_name]).strip() if i_name >= 0 and row[i_name] else ""
        score = _match_score(q, secid, shortname, fullname)
        if score is None:
            continue

        seen.add(secid)
        stype = "currency" if group == "currency_selt" else "stock"
        out.append({
            "symbol": f"MOEX:{secid}",
            "ticker": secid,
            "name": shortname or fullname or secid,
            "type": stype,
            "exchange": "MOEX",
            "logo": None,
            "score": score,
        })

    # Статические индексы: точное совпадение тикера или вхождение в название
    for secid, title in _MOEX_INDICES.items():
        score = _match_score(q, secid, title)
        if score is None or secid in seen:
            continue
        seen.add(secid)
        out.append({
            "symbol": f"MOEX:{secid}",
            "ticker": secid,
            "name": title,
            "type": "index",
            "exchange": "MOEX",
            "logo": None,
            "score": score,
        })

    out.sort(key=lambda r: (r["score"], r["ticker"]))
    return out


async def _search_moex(query: str, limit: int) -> list[dict]:
    """Поиск по ISS (q ищет по SECID/SHORTNAME/NAME/ISIN). Ошибка сети/ISS —
    пустой список: крипта и статические индексы остаются рабочими."""
    url = ("https://iss.moex.com/iss/securities.json"
           f"?q={quote(query)}&limit=30&iss.meta=off&iss.only=securities")
    data = await moex_service._get_json(url)
    if "error" in data:
        return []
    items = _parse_moex_securities(data, query)
    return items[:limit]


async def _ensure_binance_pairs(session: aiohttp.ClientSession) -> dict:
    """Торгуемые пары Binance (status=TRADING) с суточным кэшем. При
    недоступности справочника отдаём последний кэш (даже просроченный) —
    лучше чуть устаревший список пар, чем отсутствие крипто-подсказок."""
    now = time.time()
    if _binance_pairs_cache["pairs"] and now - _binance_pairs_cache["ts"] < _BINANCE_INFO_TTL:
        return _binance_pairs_cache["pairs"]

    async with _binance_info_lock:
        # повторная проверка: пока ждали блокировку, справочник мог загрузить
        # параллельный запрос поиска
        now = time.time()
        if _binance_pairs_cache["pairs"] and now - _binance_pairs_cache["ts"] < _BINANCE_INFO_TTL:
            return _binance_pairs_cache["pairs"]

        try:
            url = "https://api.binance.com/api/v3/exchangeInfo?permissions=SPOT"
            async with session.get(url) as resp:
                if resp.status != 200:
                    return _binance_pairs_cache["pairs"]
                data = await resp.json(content_type=None)
            pairs: dict[str, tuple[str, str]] = {}
            for s in data.get("symbols") or []:
                if s.get("status") != "TRADING":
                    continue
                base, quote = s.get("baseAsset"), s.get("quoteAsset")
                if base and quote:
                    pairs[s["symbol"]] = (str(base).upper(), str(quote).upper())
            if pairs:
                _binance_pairs_cache.update(ts=time.time(), pairs=pairs)
        except Exception:  # noqa: BLE001 — сеть/таймаут: работаем без крипты
            pass
        return _binance_pairs_cache["pairs"]


# «Стабильные» квоты: пары с ними участвуют в поиске и по вхождению запроса
# в символ пары. Для экзотических квот (BTC, ETH, TRY, EUR…) — только точные
# совпадения по базовому активу (или точный код пары): иначе запрос «btc»
# заваливается парами вида ADABTC/AVAXBTC, где BTC — лишь котируемый актив.
_STABLE_QUOTES = {"USDT", "FDUSD", "USDC", "TUSD", "BUSD", "DAI"}


def _rank_binance_pairs(pairs: dict, q: str, limit: int) -> list[tuple[str, str]]:
    """Лучшие пары по запросу: [(SYMBOL, baseAsset)]. Одна строка на монету
    (дедупликация по base с приоритетом котируемого актива) — как в
    TradingView, где поиск показывает инструмент, а не все его рынки."""
    quote_rank = {qt: i for i, qt in enumerate(_QUOTE_PRIORITY)}
    scored = []
    for sym, (base, quote) in pairs.items():
        if quote in _STABLE_QUOTES:
            if base == q:
                score = 0.0
            elif sym == q:
                score = 0.1
            elif base.startswith(q):
                score = 1.0
            elif sym.startswith(q):
                score = 1.5
            elif q in base:
                score = 2.0
            elif q in sym:
                score = 2.5
            else:
                continue
        else:
            if sym == q:
                score = 0.3      # точный код пары вводят осознанно — показываем
            elif base == q:
                score = 0.2
            elif base.startswith(q):
                score = 1.0
            elif q in base:
                score = 2.0
            else:
                continue
        scored.append((score, quote_rank.get(quote, 99), sym, base))

    scored.sort(key=lambda t: (t[0], t[1], t[2]))
    out: list[tuple[str, str]] = []
    seen_base: set[str] = set()
    for _score, _qr, sym, base in scored:
        if base in seen_base:
            continue
        seen_base.add(base)
        out.append((sym, base))
        if len(out) >= limit:
            break
    return out


async def _coin_meta(session: aiohttp.ClientSession, base: str) -> tuple[Optional[str], Optional[str]]:
    """(имя, логотип) монеты через общие кэши CoinGecko (crypto_service).
    Некритичная приправа: сбой -> (None, None), подсказка остаётся по тикеру."""
    try:
        coin_id = await crypto_service.resolve_coin_id(session, base)
        if not coin_id:
            return None, None
        markets = await crypto_service._fetch_markets(session, [coin_id])
        m = markets.get(coin_id) or {}
        return m.get("name"), m.get("image")
    except Exception:  # noqa: BLE001 — имя/логотип не критичны
        return None, None


async def _search_crypto(session: aiohttp.ClientSession, query: str, limit: int) -> list[dict]:
    pairs = await _ensure_binance_pairs(session)
    if not pairs:
        return []
    top = _rank_binance_pairs(pairs, query.upper(), limit)
    if not top:
        return []
    metas = await asyncio.gather(
        *(_coin_meta(session, base) for _, base in top), return_exceptions=True)
    items = []
    for (sym, base), meta in zip(top, metas):
        name, logo = meta if isinstance(meta, tuple) else (None, None)
        items.append({
            "symbol": f"BINANCE:{sym}",
            "ticker": sym,
            "name": name,
            "type": "crypto",
            "exchange": "BINANCE",
            "logo": logo,
            # база совпадает с запросом — так же релевантно, как точный тикер MOEX;
            # остальные вхождения — немного ниже точных совпадений MOEX
            "score": 0.0 if base == query.upper() else (0.4 if sym == query.upper() else 2.2),
        })
    return items


async def search_symbols(query: str, limit: int = 8) -> dict:
    """Объединённый поиск MOEX + крипта, отсортированный по релевантности
    (при равной оценке MOEX первее). Сети недоступны -> пустая выдача без ошибки."""
    query = (query or "").strip().upper()
    if len(query) < 2:
        return {"results": []}

    # Сессия с запасом на разовую загрузку справочника exchangeInfo (~17 МБ):
    # фронтенд отвалится по своему таймауту, но сервер докачает и закэширует
    # справочник — следующая подсказка будет мгновенной
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        moex_res, crypto_res = await asyncio.gather(
            _search_moex(query, limit),
            _search_crypto(session, query, limit),
            return_exceptions=True,
        )

    moex_items = moex_res if isinstance(moex_res, list) else []
    crypto_items = crypto_res if isinstance(crypto_res, list) else []
    merged = sorted(
        moex_items + crypto_items,
        key=lambda r: (r["score"], 0 if r["exchange"] == "MOEX" else 1, r["ticker"]),
    )
    for r in merged:
        r.pop("score", None)
    return {"results": merged[:limit]}
