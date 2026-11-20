import asyncio
import os
import time
from pathlib import Path
from typing import Optional

import aiohttp
from dotenv import load_dotenv

# .env ищем рядом с модулем (backend/.env) и в корне проекта — как в
# notification_service. Токен Algopack нужен для авторизованного ISS
# (котировки без задержки ~15 мин анонимного доступа).
for _candidate in (Path(__file__).resolve().parent.parent / ".env",
                   Path(__file__).resolve().parent.parent.parent / ".env"):
    if _candidate.exists():
        load_dotenv(_candidate)


def get_moex_token() -> str:
    """Bearer-токен ISS из .env/окружения; пустая строка, если не задан."""
    return (os.getenv("MOEX_API_TOKEN") or "").strip()


async def _get_json(url: str, headers: Optional[dict] = None) -> dict:
    """GET url -> dict ISS; при сетевой ошибке/не-200 возвращает {'error': …}."""
    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
        try:
            async with session.get(url, headers=headers or {}) as response:
                if response.status != 200:
                    return {"error": f"Not found (Status {response.status})"}
                return await response.json()
        except asyncio.TimeoutError:
            return {"error": "Timeout"}
        except Exception as e:
            return {"error": str(e)}

# Свечи ISS: с токеном Algopack — apim.moex.com (данные без задержки),
# без токена — анонимный iss.moex.com (лаг ~15 минут, для тестового графика
# этого достаточно).
async def fetch_moex_candles(
    ticker: str,
    interval: int = 24,
    from_date: Optional[str] = None,
    till_date: Optional[str] = None,
) -> dict:
    """Свечи OHLCV (акции, режим TQBR) — МАКСИМАЛЬНАЯ история.

    interval: 1 (мин), 10, 60 (час), 24 (день), 7 (неделя), 31 (месяц) —
    стандартные интервалы ISS. from/till: даты 'YYYY-MM-DD' (опционально).

    С токеном MOEX_API_TOKEN запрос идёт на apim.moex.com с заголовком
    Authorization: Bearer (котировки без задержки); если токен не принят —
    откат на анонимный iss.moex.com.

    ISS отдаёт не более 500 свечей за запрос, поэтому история собирается
    пагинацией параметром start (0, 500, 1000, …) до конца доступных данных
    (без from это вся история тикера, для GAZP — с 2014 г.). Защита от
    бесконечного цикла — жёсткий лимит MAX_CANDLES.
    Возвращает сырые свечи ISS: open/close/high/low/volume/value + begin/end.
    """
    ticker = ticker.upper().strip()
    token = get_moex_token()

    def base_url(use_apim: bool) -> str:
        host = "apim.moex.com" if use_apim else "iss.moex.com"
        board = "tqbr" if use_apim else "TQBR"
        url = (
            f"https://{host}/iss/engines/stock/markets/shares/"
            f"boards/{board}/securities/{ticker}/candles.json"
            f"?interval={interval}"
        )
        if from_date:
            url += f"&from={from_date}"
        if till_date:
            url += f"&till={till_date}"
        return url

    headers = {"Authorization": f"Bearer {token}"} if token else {}
    use_apim = bool(token)   # при отказе apim падаем на анонимный ISS

    PAGE_SIZE = 500          # максимум свечей в одном ответе ISS
    MAX_CANDLES = 50000      # страховка от бесконечной пагинации

    columns = None
    rows = []

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30)) as session:
        start = 0
        while start < MAX_CANDLES:
            try:
                async with session.get(f"{base_url(use_apim)}&start={start}",
                                       headers=headers if use_apim else {}) as response:
                    if response.status != 200:
                        if not rows and use_apim:
                            # apim не принял токен / недоступен — откат на
                            # анонимный ISS (данные с задержкой ~15 мин)
                            use_apim = False
                            continue
                        if not rows:  # ошибка на первой странице — сообщаем
                            return {"symbol": f"MOEX:{ticker}", "error": f"Not found (Status {response.status})"}
                        break       # ошибка в середине — отдаём что успели собрать
                    data = await response.json()
            except asyncio.TimeoutError:
                if not rows and use_apim:
                    use_apim = False
                    continue
                if not rows:
                    return {"symbol": f"MOEX:{ticker}", "error": "Timeout"}
                break
            except Exception as e:
                if not rows and use_apim:
                    use_apim = False
                    continue
                if not rows:
                    return {"symbol": f"MOEX:{ticker}", "error": str(e)}
                break

            candles = data.get("candles") or {}
            if columns is None:
                columns = candles.get("columns") or []
            page = candles.get("data") or []
            rows.extend(page)
            if len(page) < PAGE_SIZE:
                break  # последняя страница истории
            start += PAGE_SIZE

    if not columns or not rows:
        return {"symbol": f"MOEX:{ticker}", "error": "No candles data", "candles": []}

    def get_col(row, name):
        try:
            return row[columns.index(name)]
        except ValueError:
            return None

    result = []
    for row in rows:
        result.append({
            "open": get_col(row, "open"),
            "close": get_col(row, "close"),
            "high": get_col(row, "high"),
            "low": get_col(row, "low"),
            "volume": get_col(row, "volume"),
            "value": get_col(row, "value"),
            "begin": get_col(row, "begin"),
            "end": get_col(row, "end"),
        })

    return {
        "symbol": f"MOEX:{ticker}",
        "interval": interval,
        "candles": result,
    }


async def fetch_moex_price(ticker: str) -> dict:
    ticker = ticker.upper().strip()
    token = get_moex_token()

    # 1. Индексы (IMOEX, RTSI, RGBI, IRUS)
    if ticker in ['IMOEX', 'RTSI', 'RGBI', 'IRUS']:
        url = f"https://iss.moex.com/iss/engines/stock/markets/index/securities/IMOEX.json?spm=a2ty_o01.29997173.0.0.144e55fbQlTBXd&file=RTSI.json{ticker}.json"
    # 2. Валюты (BYNRUB, CNYRUB, USD000UTSTOM и любые с RUB)
    elif 'RUB' in ticker or ticker in ['USD000UTSTOM', 'EUR_RUB__TOM']:
        url = f"https://iss.moex.com/iss/engines/currency/markets/currencies/boards/CETS/securities/{ticker}.json"
    # 3. Акции и облигации (по умолчанию)
    else:
        if token:
            # Авторизованный ISS (Algopack): котировки без задержки ~15 мин.
            # Авторизация — Bearer-токен в заголовке самого запроса
            # (отдельного шага логина у ISS нет).
            url = (f"https://apim.moex.com/iss/engines/stock/markets/shares/"
                   f"boards/tqbr/securities/{ticker}.json")
        else:
            url = f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/{ticker}.json"

    headers = {}
    if token and "apim.moex.com" in url:
        headers["Authorization"] = f"Bearer {token}"

    data = await _get_json(url, headers)

    # apim не ответил или не принял токен (401/403) — откат на анонимный ISS,
    # чтобы ручка watchlist не отваливалась (данные будут с задержкой ~15 мин).
    if "error" in data and "apim.moex.com" in url:
        anon_url = f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/{ticker}.json"
        data = await _get_json(anon_url)

    if "error" in data:
        return {"symbol": f"MOEX:{ticker}", "error": data["error"]}

    # MOEX возвращает данные в сложной структуре. Ищем marketdata
    if not data.get('marketdata') or not data['marketdata'].get('data'):
        return {"symbol": f"MOEX:{ticker}", "error": "No data in marketdata"}

    columns = data['marketdata']['columns']
    row = data['marketdata']['data'][0]

    # Безопасная функция для получения значения по имени колонки
    def get_col(name):
        try:
            return row[columns.index(name)]
        except ValueError:
            return None

    # Для индексов иногда используется LASTVALUE, для акций LAST
    price = get_col('LAST') or get_col('LASTVALUE') or get_col('VALTODAY')
    change_percent = get_col('LASTTOPREVPRICE') or get_col('LASTCHANGEPRC')
    change_value = get_col('CHANGE') or get_col('LASTCHANGE')

    return {
        "symbol": f"MOEX:{ticker}",
        "price": float(price) if price else None,
        "changeDay": float(change_percent) if change_percent else None,
        "changeValue": float(change_value) if change_value else None
    }


# Кэш названий бумаг (шапка «Тест график»): {TICKER: {"name": str|None, "ts": float}}.
# Имя бумаги почти вечно — положительный результат живёт в процессе; неудача
# (ISS недоступен) кэшируется на 10 минут, чтобы не тормозить каждый запрос.
_moex_name_cache: dict[str, dict] = {}
_NAME_NEG_TTL = 600.0


async def fetch_moex_name(ticker: str) -> Optional[str]:
    """Короткое название бумаги (SHORTNAME ISS, напр. «Сбербанк») для шапки графика.

    Запрашивается securities.json той же доски TQBR, что и котировки
    (см. fetch_moex_price), с тем же откатом apim → анонимный ISS.
    """
    ticker = ticker.upper().strip()
    cached = _moex_name_cache.get(ticker)
    now = time.monotonic()
    if cached and (cached["name"] is not None or now - cached["ts"] < _NAME_NEG_TTL):
        return cached["name"]

    token = get_moex_token()
    host = "apim.moex.com" if token else "iss.moex.com"
    board = "tqbr" if token else "TQBR"
    url = (f"https://{host}/iss/engines/stock/markets/shares/"
           f"boards/{board}/securities/{ticker}.json")
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    data = await _get_json(url, headers)
    if "error" in data and token:
        # apim не ответил или не принял токен — откат на анонимный ISS,
        # чтобы имя не пропадало вместе с токеном (как в fetch_moex_price)
        data = await _get_json(
            f"https://iss.moex.com/iss/engines/stock/markets/shares/"
            f"boards/TQBR/securities/{ticker}.json")

    name = None
    sec = data.get("securities") or {}
    cols = sec.get("columns") or []
    rows = sec.get("data") or []
    if cols and rows:
        try:
            v = rows[0][cols.index("SHORTNAME")]
            name = str(v).strip() if v else None
        except ValueError:
            pass
    _moex_name_cache[ticker] = {"name": name, "ts": now}
    return name


def _parse_board_marketdata(data: dict, tickers: list[str]) -> dict[str, dict]:
    """Достаём цены запрошенных тикеров из снапшота целой доски ISS.

    Формат блоков тот же, что у одиночного ответа (marketdata/columns/data),
    но строк несколько, а первой колонкой идёт SECID — по нему и выбираем.
    """
    md = data.get('marketdata') or {}
    columns = md.get('columns') or []
    rows = md.get('data') or []
    if not columns or not rows:
        return {}
    try:
        i_sec = columns.index('SECID')
    except ValueError:
        return {}

    wanted = set(tickers)
    by_secid = {row[i_sec]: row for row in rows if row[i_sec] in wanted}

    out: dict[str, dict] = {}
    for t in tickers:
        row = by_secid.get(t)
        if row is None:
            continue

        def get_col(name):
            try:
                return row[columns.index(name)]
            except ValueError:
                return None

        # Для индексов иногда используется LASTVALUE, для акций LAST
        price = get_col('LAST') or get_col('LASTVALUE') or get_col('VALTODAY')
        change_percent = get_col('LASTTOPREVPRICE') or get_col('LASTCHANGEPRC')
        change_value = get_col('CHANGE') or get_col('LASTCHANGE')
        out[t] = {
            "symbol": f"MOEX:{t}",
            "price": float(price) if price else None,
            "changeDay": float(change_percent) if change_percent else None,
            "changeValue": float(change_value) if change_value else None,
        }
    return out


async def _fetch_board_prices(engine: str, market: str, board: str,
                              tickers: list[str]) -> dict[str, dict]:
    """Цены акций одним снапшотом доски TQBR (marketdata всех бумаг).

    engine=stock, market=shares, board=TQBR. С токеном — apim.moex.com
    (без задержки ~15 мин), при отказе — откат на анонимный iss.moex.com.
    marketdata.columns сужает ответ до нужных колонок — снапшот доски
    остаётся лёгким даже при частом real-time-опросе.
    """
    token = get_moex_token()
    host = "apim.moex.com" if token else "iss.moex.com"
    board_name = board.lower() if token else board
    cols = ("SECID,LAST,LASTVALUE,LASTCHANGE,LASTCHANGEPRC,"
            "LASTTOPREVPRICE,CHANGE,VALTODAY")
    url = (f"https://{host}/iss/engines/{engine}/markets/{market}/"
           f"boards/{board_name}/securities.json?marketdata.columns={cols}")
    headers = {"Authorization": f"Bearer {token}"} if token else {}

    data = await _get_json(url, headers)
    if "error" in data and token:
        anon_url = (f"https://iss.moex.com/iss/engines/{engine}/markets/{market}/"
                    f"boards/{board}/securities.json?marketdata.columns={cols}")
        data = await _get_json(anon_url)
    if "error" in data:
        return {}
    return _parse_board_marketdata(data, tickers)


async def fetch_moex_prices_batch(tickers: list[str]) -> dict[str, dict]:
    """Цены сразу для нескольких тикеров Мосбиржи — минимум HTTP-запросов.

    Группа «акции TQBR» берётся одним снапшотом доски (один запрос на весь
    список), поэтому real-time-опрос watchlist акций создаёт 1 запрос к MOEX
    вместо запроса на каждый тикер. Валюты и индексы ISS снапшотом доски не
    отдаёт (анонимный список бумаг пустой / у индексов особый URL) — тянутся
    параллельными одиночными запросами через fetch_moex_price.
    Возвращает {тикер_без_префикса: ответ той же формы, что у /api/prices}.
    """
    tickers = list(dict.fromkeys(t.upper().strip() for t in tickers if t and t.strip()))
    if not tickers:
        return {}

    index_tickers = [t for t in tickers if t in ('IMOEX', 'RTSI', 'RGBI', 'IRUS')]
    currency_tickers = [t for t in tickers if t not in index_tickers
                        and ('RUB' in t or t in ('USD000UTSTOM', 'EUR_RUB__TOM'))]
    share_tickers = [t for t in tickers
                     if t not in index_tickers and t not in currency_tickers]

    tasks = []
    if share_tickers:
        tasks.append(_fetch_board_prices("stock", "shares", "TQBR", share_tickers))
    single_tickers = index_tickers + currency_tickers
    if single_tickers:
        tasks.append(asyncio.gather(
            *(fetch_moex_price(t) for t in single_tickers), return_exceptions=True))

    out: dict[str, dict] = {t: {"symbol": f"MOEX:{t}", "error": "No data"} for t in tickers}
    results = await asyncio.gather(*tasks, return_exceptions=True)
    for res in results:
        if isinstance(res, BaseException):
            continue
        if isinstance(res, dict):
            out.update(res)                       # снапшот доски: {тикер: ответ}
        elif isinstance(res, (list, tuple)):      # индексы: список ответов
            for r in res:
                if isinstance(r, dict) and str(r.get("symbol", "")).startswith("MOEX:"):
                    out[str(r["symbol"]).replace("MOEX:", "")] = r
    return out
