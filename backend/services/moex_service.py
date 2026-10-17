import asyncio
import time
import aiohttp


async def fetch_moex_price(ticker: str) -> dict:
    ticker = ticker.upper().strip()

    # 1. Индексы (IMOEX, RTSI, RGBI, IRUS)
    if ticker in ['IMOEX', 'RTSI', 'RGBI', 'IRUS']:
        url = f"https://iss.moex.com/iss/engines/stock/markets/index/securities/IMOEX.json?spm=a2ty_o01.29997173.0.0.144e55fbQlTBXd&file=RTSI.json{ticker}.json"
    # 2. Валюты (BYNRUB, CNYRUB, USD000UTSTOM и любые с RUB)
    elif 'RUB' in ticker or ticker in ['USD000UTSTOM', 'EUR_RUB__TOM']:
        url = f"https://iss.moex.com/iss/engines/currency/markets/currencies/boards/CETS/securities/{ticker}.json"
    # 3. Акции и облигации (по умолчанию)
    else:
        url = f"https://iss.moex.com/iss/engines/stock/markets/shares/boards/TQBR/securities/{ticker}.json"

    async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as session:
        try:
            async with session.get(url) as response:
                if response.status != 200:
                    return {"symbol": f"MOEX:{ticker}", "error": f"Not found (Status {response.status})"}
                data = await response.json()
        except asyncio.TimeoutError:
            return {"symbol": f"MOEX:{ticker}", "error": "Timeout"}
        except Exception as e:
            return {"symbol": f"MOEX:{ticker}", "error": str(e)}

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


# =============================================================================
# ДИВИДЕНДЫ / КОРПОРАТИВНЫЕ СОБЫТИЯ (ISS Мосбиржи: eventencalendar)
# -----------------------------------------------------------------------------
# https://iss.moex.com/iss/engines/stock/markets/shares/securities/{TICKER}/
#   eventencalendar.json — календарь корпоративных событий бумаги: дивиденды
#   (type='Dividends'), даты отсечки реестра, годовые/внеочередные собрания,
#   погашения облигаций и т.п. Ответ отдаётся только для MOEX-тикеров; для
#   индексов и валютных пар у Мосбиржи таких событий нет — возвращаем пусто.
# Результат кэшируется в памяти на EVENT_CACHE_TTL секунд (MOEX не любит частые
# опросы одного и того же эндпоинта, а данные меняются редко).
# =============================================================================

EVENT_CACHE_TTL = 600  # 10 минут
_events_cache: dict = {}  # ticker -> {"data": {...}, "ts": float}

# Индексы и валютные пары MOEX — корпоративных событий не имеют
_NO_EVENTS_PREFIXES = ('USD000', 'EUR_RUB', 'CNYRUB', 'BYNRUB')
_NO_EVENTS_TICKERS = {'IMOEX', 'RTSI', 'RGBI', 'IRUS', 'MOEX', 'INDEX_RTS', 'RGBITR'}

# Известные типы событий ISS → человекочитаемые метки
_EVENT_TYPE_LABELS = {
    'Dividends': 'Дивиденды',
    'StocksSplit': 'Сплит акций',
    'AdditionalShareIssue': 'Допэмиссия',
    'BondOffering': 'Размещение облигаций',
    'BondRedemption': 'Погашение облигаций',
    'BondCouponPayment': 'Купонная выплата',
    'AnnualGeneralMeeting': 'Годовое собрание акционеров',
    'ExtraordinaryGeneralMeeting': 'Внеочередное собрание акционеров',
    'BoardOfDirectorsMeeting': 'Заседание совета директоров',
    'Earnings': 'Отчётность',
    'BookClosing': 'Закрытие книги (отсечка)',
    'Other': 'Прочее',
}


def _ev_get(row, columns, name):
    """Безопасное извлечение значения колонки строки ISS-ответа."""
    try:
        return row[columns.index(name)]
    except (ValueError, IndexError):
        return None


async def fetch_moex_events(ticker: str) -> dict:
    """Календарь дивидендов и корпоративных событий бумаги MOEX (ISS)."""
    ticker = ticker.upper().strip()

    if not ticker or ticker in _NO_EVENTS_TICKERS or ticker.startswith(_NO_EVENTS_PREFIXES):
        return {"symbol": f"MOEX:{ticker}", "events": [], "source": "moex_iss_eventencalendar"}

    cached = _events_cache.get(ticker)
    if cached and (time.time() - cached["ts"]) < EVENT_CACHE_TTL:
        return cached["data"]

    url = ("https://iss.moex.com/iss/engines/stock/markets/shares/securities/"
           f"{ticker}/eventencalendar.json")
    params = {
        # Отсечка «из прошлого» слишком далеко — берём все доступные события
        # одной страницей; from/to задаём ниже явным диапазоном.
        "from": "2020-01-01",
        "to": "2035-12-31",
        "order_by": "event_date",
        "order_value": "DESC",
        "limit": 200,
    }

    events = []
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as session:
            async with session.get(url, params=params) as response:
                if response.status != 200:
                    result = {"symbol": f"MOEX:{ticker}", "events": [],
                              "error": f"Not found (Status {response.status})",
                              "source": "moex_iss_eventencalendar"}
                    return result
                data = await response.json()
    except asyncio.TimeoutError:
        return {"symbol": f"MOEX:{ticker}", "events": [], "error": "Timeout",
                "source": "moex_iss_eventencalendar"}
    except Exception as e:
        return {"symbol": f"MOEX:{ticker}", "events": [], "error": str(e),
                "source": "moex_iss_eventencalendar"}

    ec = data.get("eventencalendar") or {}
    columns = ec.get("columns") or []
    for row in (ec.get("data") or []):
        ev_type = _ev_get(row, columns, "type")
        events.append({
            "id": _ev_get(row, columns, "id"),
            "secId": _ev_get(row, columns, "secid"),
            "type": ev_type,
            "typeLabel": _EVENT_TYPE_LABELS.get(ev_type, ev_type or "Событие"),
            "name": _ev_get(row, columns, "name"),
            "eventDate": _ev_get(row, columns, "event_date"),
            "registDate": _ev_get(row, columns, "regist_date"),       # отсечка реестра
            "detailText": _ev_get(row, columns, "detail_text"),
            "value": _ev_get(row, columns, "value"),                  # напр. дивиденд на акцию
            "valueCurrency": _ev_get(row, columns, "value_currency"),
            "property": _ev_get(row, columns, "property"),
            "docUrl": _ev_get(row, columns, "doc"),
            "url": _ev_get(row, columns, "url"),
            "status": _ev_get(row, columns, "status"),
        })

    today = time.strftime("%Y-%m-%d")
    upcoming = [e for e in events if (e["registDate"] or e["eventDate"] or "") >= today]
    past = [e for e in events if (e["registDate"] or e["eventDate"] or "") < today]

    result = {
        "symbol": f"MOEX:{ticker}",
        "events": events,     # все события (сортировка обратная: свежие сверху)
        "upcoming": upcoming, # ближайшие (ещё не прошли)
        "past": past,         # прошедшие
        "dividendCount": sum(1 for e in events if e.get("type") == "Dividends"),
        "source": "moex_iss_eventencalendar",
    }
    _events_cache[ticker] = {"data": result, "ts": time.time()}
    return result

