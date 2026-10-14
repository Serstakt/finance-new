"""
Сервис цен криптовалют (CoinGecko Free API).

История бага: раньше coin_id вычислялся из тикера пары грубыми заменами
    symbol.lower().replace('usdt','').replace('btc','bitcoin').replace('eth','ethereum')
из-за чего:
  * SOLUSDT  -> "sol"      -> NOT FOUND (правильный id: "solana")
  * WBTCUSDT -> "wbitcoin" -> NOT FOUND (правильный id: "wrapped-bitcoin")
  * DOGEUSDT -> "doge"     -> NOT FOUND (правильный id: "dogecoin")

Теперь используется многоуровневый маппинг Binance-символа -> CoinGecko id:
  1. Статический словарь STATIC_MAP для монет, где id != символ (solana, ripple, ...).
  2. Кэш /coins/list (~22000 монет, обновление раз в сутки): среди кандидатов
     по символу выбираем монету с id == символ, иначе — «чистый» id без мусора
     (bridged/wormhole/binance-peg).
  3. Фолбэк /search?query=<sym>: первый кандидат с точным совпадением символа,
     отсортированный по рангу капитализации.
  4. Ленивая гипотеза id == символ через прямую проверку /coins/markets.

Данные берутся из /coins/markets пакетным запросом (batch) — это снимает проблему
лимитов /simple/price и заполняет все поля PriceResponse (changeValue, changeWeek,
changeMonth, changeYear), которые раньше всегда были пустыми.
"""

import asyncio
import time
from typing import Optional

import aiohttp

API_BASE = "https://api.coingecko.com/api/v3"

# TTL кэшей (секунды)
LIST_TTL = 24 * 3600        # список монет обновляем раз в сутки
SEARCH_TTL = 24 * 3600      # результаты поиска — на сутки
MARKETS_TTL = 60            # цены — раз в минуту (лимит free API ~10-30 req/min)
NEGATIVE_TTL = 300          # "не найдено" помним 5 минут, чтобы не долбить API

# Монеты, у которых CoinGecko id НЕ совпадает с тикером биржи.
# Покрывает самые частые Binance-пары; остальное дорешают кэш /coins/list и /search.
STATIC_MAP: dict[str, str] = {
    "BTC": "bitcoin",
    "ETH": "ethereum",
    "SOL": "solana",
    "XRP": "ripple",
    "TRX": "tron",
    "TRON": "tron",  # на бирже тикер TRX, но пары вида TRONUSD тоже встречаются;
                    # в /coins/list id==символ не срабатывает (символ монеты "trx")
    "BNB": "binancecoin",
    "DOGE": "dogecoin",
    "ADA": "cardano",
    "SHIB": "shiba-inu",
    "LTC": "litecoin",
    "AVAX": "avalanche-2",
    "LINK": "chainlink",
    "DOT": "polkadot",
    "MATIC": "matic-network",
    "WBTC": "wrapped-bitcoin",
    "WBETH": "wrapped-beacon-eth",
    "WETH": "weth",
    "STETH": "staked-ether",
    "FDUSD": "first-digital-usd",
    "TUSD": "true-usd",
    "USDC": "usd-coin",
    "USDP": "usdp",
    "DAI": "multi-collateral-dai",
    "GUSD": "gemini-dollar",
    "BUSD": "binance-usd",
    "USTC": "terra-luna-2",
    "LUNA": "terra-luna-2",
    "PEPE": "pepe",
    "WIF": "dogwifcoin",
    "BONK": "bonk",
    "FLOKI": "floki",
    "UNI": "uniswap",
    "ATOM": "cosmos",
    "FIL": "filecoin",
    "APT": "aptos",
    "ARB": "arbitrum",
    "OP": "optimism",
    "NEAR": "near",
    "VET": "vechain",
    "ICP": "internet-computer",
    "RUNE": "thorchain",
    "QNT": "quant-network",
    "ALGO": "algo",
    "SAND": "the-sandbox",
    "MANA": "decentraland",
    "AXS": "axie-infinity",
    "GALA": "gala",
    "XTZ": "tezos",
    "FLOW": "flow",
    "HBAR": "hedera-hashgraph",
    "INJ": "injective-protocol",
    "SUI": "sui",
    "SEI": "sei-network",
    "TIA": "celestia",
    "ENA": "ethena",
    "ONDO": "ondo-finance",
    "WLD": "worldcoin-wld",
    "TON": "the-open-network",
    "AAVE": "aave",
    "MKR": "maker",
    "CRV": "curve-dao-token",
    "LDO": "lido-dao",
    "ETC": "ethereum-classic",
    "XLM": "stellar",
    "XMR": "monero",
    "ZEC": "zcash",
    "DASH": "dash",
    "EGLD": "multiversx",
    "AR": "arweave",
    "GRT": "the-graph",
    # id algorand != "algo" — в /coins/list есть мусор-кандидат "dear-algorithm",
    # который выбирался по критерию «самый короткий id»
    "ALGO": "algorand",
}


def _is_probably_delisted(m: dict) -> bool:
    """CoinGecko отдаёт price=None или пустые изменения для мёртвых/делистнутых монет
    (пример: matic-network после перехода на POL). Такую запись не кешируем как валидную."""
    if m.get("current_price") is None:
        return True
    pct_keys = [k for k in m if k.startswith("price_change_percentage_") and k.endswith("_in_currency")]
    return bool(pct_keys) and all(m.get(k) is None for k in pct_keys)

# --- кэши (в памяти процесса) ------------------------------------------------
_coins_list_cache: dict = {"ts": 0.0, "data": None}   # SYMBOL -> [{"id","name"}]
_search_cache: dict[str, dict] = {}                   # symbol -> {"ts", "id"}
_markets_cache: dict[str, dict] = {}                  # coingecko_id -> {"ts", "data"}
_negative_cache: dict[str, float] = {}                # symbol -> ts неудачи

_QUOTE_SUFFIXES = ("USDT", "USDC", "FDUSD", "TUSD", "BUSD", "DAI", "EUR", "TRY", "BTC", "ETH")


# Binance-префиксы объёма: '1000SATS' -> базовый символ 'SATS' (id: 1000sats-ordinals)
_VOL_PREFIXES = ("1000000", "100000", "10000", "1000")


def _base_symbol(symbol: str) -> str:
    """'SOLUSDT' -> 'SOL', '1000SATSUSDT' -> 'SATS';
    если суффикс котировки не отрезался — возвращаем как есть."""
    s = symbol.upper().strip()
    for q in _QUOTE_SUFFIXES:
        if s.endswith(q) and len(s) > len(q):
            s = s[: -len(q)]
            break
    for p in _VOL_PREFIXES:
        if s.startswith(p) and len(s) > len(p):
            return s[len(p):]
    return s


def _symbol_variants(symbol: str) -> list[str]:
    """Варианты базового символа для резолвинга: с префиксом объёма и без.
    '1000SATSUSDT' -> ['SATS', '1000SATS'] (CoinGecko любит оба варианта)."""
    s = symbol.upper().strip()
    for q in _QUOTE_SUFFIXES:
        if s.endswith(q) and len(s) > len(q):
            s = s[: -len(q)]
            break
    variants = [s]
    for p in _VOL_PREFIXES:
        if s.startswith(p) and len(s) > len(p):
            variants.append(s[len(p):])
            break
    # дедупликация с сохранением порядка
    return list(dict.fromkeys(variants))


async def _get(session: aiohttp.ClientSession, path: str, params: dict | None = None):
    url = f"{API_BASE}{path}"
    try:
        async with session.get(url, params=params) as resp:
            if resp.status == 429:
                return {"__rate_limited__": True}
            if resp.status != 200:
                return None
            return await resp.json()
    except (aiohttp.ClientError, asyncio.TimeoutError):
        return None


# ---------------------------------------------------------------------------
# Шаг 2: кэш /coins/list — SYMBOL -> список монет с этим символом
# ---------------------------------------------------------------------------
async def _ensure_coins_list(session: aiohttp.ClientSession) -> Optional[dict]:
    now = time.time()
    if _coins_list_cache["data"] is not None and now - _coins_list_cache["ts"] < LIST_TTL:
        return _coins_list_cache["data"]

    data = await _get(session, "/coins/list")
    if not isinstance(data, list):
        # Не удалось загрузить — отдаём старый (возможно протухший) кэш, если он есть
        return _coins_list_cache["data"]

    by_symbol: dict[str, list] = {}
    for c in data:
        # name участвует в disambiguation (см. _pick_from_candidates):
        # у TRON id == "tron", но на бирже тикер "TRX" — имя закрывает гэп.
        by_symbol.setdefault(c["symbol"].upper(), []).append(
            {"id": c["id"], "name": c["name"]}
        )
    _coins_list_cache.update(ts=now, data=by_symbol)
    return by_symbol


def _is_junk_id(cid: str) -> bool:
    cid = cid.lower()
    return any(k in cid for k in (
        "bridged", "wormhole", "binance-peg", "hyperscale", "ocean-bridged",
        "polygon-pos", "heco", "cronos", "fantum", "fantom",
    ))


def _pick_from_candidates(candidates: list[dict], sym: str) -> Optional[str]:
    """Из списка монет с одинаковым символом выбираем «ту самую»."""
    if not candidates:
        return None
    ids = [c["id"] for c in candidates]
    # 1) точное совпадение id или названия с искомаемым тикером.
    #    Название важно для кейсов типа TRON: на бирже тикер "TRX", а в
    #    /coins/list монета лежит под символом "trx" с id "tron" — но если
    #    пользователь передал "TRONUSD", симол не поможет, поможет name.
    #    При нескольких точных id-совпадениях берём лучший market_cap_rank,
    #    иначе среди клонов вида "captain-tron" выигрывает алфавит.
    s = sym.lower()
    exact_ids = [c for c in candidates if c["id"] == s]
    if exact_ids:
        best = min(exact_ids, key=lambda c: c.get("market_cap_rank") or 10**9)
        return best["id"]
    exact_names = [c for c in candidates if c.get("name", "").lower() == s]
    if exact_names:
        return exact_names[0]["id"]
    # 2) id вида "<символ>-<что-то>" отсутствует; берём не-мусорные id,
    #    самый короткий обычно основной актив (shiba-inu vs shiba-inu-wormhole)
    clean = [i for i in ids if not _is_junk_id(i)]
    pool = clean or ids
    return sorted(pool, key=lambda i: (i.count("-"), len(i)))[0]


# ---------------------------------------------------------------------------
# Шаг 3: фолбэк /search (там сразу виден точный символ и ранг капитализации)
# ---------------------------------------------------------------------------
async def _resolve_via_search(session: aiohttp.ClientSession, sym: str) -> Optional[str]:
    cached = _search_cache.get(sym)
    if cached and time.time() - cached["ts"] < SEARCH_TTL:
        return cached["id"]

    data = await _get(session, "/search", {"query": sym.lower()})
    if not isinstance(data, dict):
        return None
    coins = data.get("coins") or []
    matches = [c for c in coins if (c.get("symbol") or "").upper() == sym]
    if not matches:
        return None
    matches.sort(key=lambda c: c.get("market_cap_rank") or 10**9)
    coin_id = matches[0]["id"]
    _search_cache[sym] = {"ts": time.time(), "id": coin_id}
    return coin_id


# ---------------------------------------------------------------------------
# Основной резолвер: символ пары -> coin_gecko_id
# ---------------------------------------------------------------------------
async def resolve_coin_id(session: aiohttp.ClientSession, symbol: str) -> Optional[str]:
    variants = _symbol_variants(symbol)   # ['SATS', '1000SATS'] для 1000SATSUSDT
    primary = variants[0]

    # негативный кэш: недавно не нашли — не долбим API
    neg_ts = _negative_cache.get(primary)
    if neg_ts and time.time() - neg_ts < NEGATIVE_TTL:
        return None

    for sym in variants:
        # 1. статический словарь
        coin_id = STATIC_MAP.get(sym)
        if coin_id:
            return coin_id

    # 2. кэш /coins/list (пробуем каждый вариант символа)
    by_symbol = await _ensure_coins_list(session)
    if by_symbol:
        for sym in variants:
            picked = _pick_from_candidates(by_symbol.get(sym, []), sym)
            if picked:
                return picked

    # 3. /search
    for sym in variants:
        coin_id = await _resolve_via_search(session, sym)
        if coin_id:
            return coin_id

    # 4. ленивая гипотеза: id == символ, проверяем прямым запросом markets
    guesses = list(dict.fromkeys(v.lower() for v in variants))
    data = await _get(session, "/coins/markets", {
        "vs_currency": "usd", "ids": ",".join(guesses),
        "price_change_percentage": "24h,7d,30d,1y",
    })
    if isinstance(data, list):
        for item in data:
            gid = item.get("id")
            if gid in guesses and not _is_probably_delisted(item):
                _markets_cache[gid] = {"ts": time.time(), "data": item}
                return gid

    _negative_cache[primary] = time.time()
    return None


# ---------------------------------------------------------------------------
# Получение данных рынка (batch + TTL-кэш)
# ---------------------------------------------------------------------------
async def _fetch_markets(session: aiohttp.ClientSession, coin_ids: list[str]) -> dict[str, dict]:
    """Возвращает {coin_id: market_obj}. Недостаточно свежие id докачиваются одним запросом."""
    now = time.time()
    stale = [cid for cid in coin_ids
             if cid not in _markets_cache or now - _markets_cache[cid]["ts"] >= MARKETS_TTL]

    if stale:
        # один batch-запрос на все недостающие id (CoinGecko принимает сотни id за запрос)
        data = await _get(session, "/coins/markets", {
            "vs_currency": "usd",
            "ids": ",".join(stale),
            "order": "market_cap_desc",
            "price_change_percentage": "24h,7d,30d,1y",
        })
        if isinstance(data, list):
            for item in data:
                if _is_probably_delisted(item):
                    # делистнутая/мёртвая запись — не отравляем кэш; при необходимости
                    # резолвер сможет предложить альтернативный id (например pol-token для MATIC)
                    continue
                _markets_cache[item["id"]] = {"ts": now, "data": item}
        # при 429/ошибке просто используем то, что уже есть в кэше (даже просроченное)

    result = {}
    for cid in coin_ids:
        entry = _markets_cache.get(cid)
        if entry:
            result[cid] = entry["data"]
    return result


def _build_response(symbol: str, m: dict) -> dict:
    price = m.get("current_price")
    change_abs = m.get("price_change_24h")
    if change_abs is None and price is not None:
        pct = m.get("price_change_percentage_24h_in_currency")
        if pct is not None:
            change_abs = price - price / (1 + pct / 100)
    return {
        "symbol": f"BINANCE:{symbol}",
        "price": price,
        "changeDay": m.get("price_change_percentage_24h_in_currency"),
        "changeValue": change_abs,
        "changeWeek": m.get("price_change_percentage_7d_in_currency"),
        "changeMonth": m.get("price_change_percentage_30d_in_currency"),
        "changeYear": m.get("price_change_percentage_1y_in_currency"),
    }


async def fetch_crypto_price(symbol: str) -> dict:
    """Цены одной пары. Совместимо со старым контрактом (main.py, portfolio_service.py)."""
    timeout = aiohttp.ClientTimeout(total=10)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        coin_id = await resolve_coin_id(session, symbol)
        if not coin_id:
            return {"symbol": f"BINANCE:{symbol}", "error": "Not found"}

        markets = await _fetch_markets(session, [coin_id])
        m = markets.get(coin_id)
        if not m:
            return {"symbol": f"BINANCE:{symbol}", "error": "API limit or error"}
        return _build_response(symbol, m)


async def fetch_crypto_prices_batch(symbols: list[str]) -> dict[str, dict]:
    """
    Цены для списка пар за минимальное число запросов:
    резолвинг id (с кэшами) + один batch /coins/markets.
    Возвращает {исходный_symbol: response_dict}.
    """
    if not symbols:
        return {}
    timeout = aiohttp.ClientTimeout(total=15)
    out: dict[str, dict] = {}
    async with aiohttp.ClientSession(timeout=timeout) as session:
        resolved: dict[str, str] = {}
        unresolved: list[str] = []
        for sym in symbols:
            coin_id = await resolve_coin_id(session, sym)
            if coin_id:
                resolved[sym] = coin_id
            else:
                unresolved.append(sym)

        markets = await _fetch_markets(session, list(dict.fromkeys(resolved.values())))

        for sym, cid in resolved.items():
            m = markets.get(cid)
            out[sym] = _build_response(sym, m) if m else {
                "symbol": f"BINANCE:{sym}", "error": "API limit or error"}
        for sym in unresolved:
            out[sym] = {"symbol": f"BINANCE:{sym}", "error": "Not found"}
    return out
