from contextlib import asynccontextmanager
import asyncio

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, Response
from pathlib import Path

from .services import moex_service, crypto_service, telegram_news_service
from .services import portfolio_service
from .services import watchlist_service
from .services import news_favorites_service
from .services import alert_service
from .models import schemas

# Путь к фронтенду
FRONTEND_PATH = Path(__file__).parent.parent / "frontend"


@asynccontextmanager
async def lifespan(application: FastAPI):
    """Монтируем статику фронтенда при старте, чтобы "/..." не перехватывал /api/*-маршруты."""
    application.mount("/css", StaticFiles(directory=FRONTEND_PATH / "css"), name="css")
    application.mount("/js", StaticFiles(directory=FRONTEND_PATH / "js"), name="js")

    # Фоновый цикл проверки ценовых алертов: алерты живут в таблице
    # price_alerts и проверяются сервером каждые 60 с — даже когда вкладка
    # браузера закрыта (раньше проверка шла только в JS при открытом терминале).
    stop_event = asyncio.Event()
    checker_task = asyncio.create_task(alert_service.run_background_checker(stop_event=stop_event))
    # Поток новостей @newssmartlab обновляется в фоне: вкладка «🚩 Избранные
    # новости» читает заголовки/время постов напрямую из news_cache и не
    # должна зависеть от того, открывал ли кто-то вкладку «Новости».
    news_task = asyncio.create_task(_news_stream_watcher(stop_event))
    try:
        yield
    finally:
        stop_event.set()
        checker_task.cancel()
        news_task.cancel()
        for task in (checker_task, news_task):
            try:
                await task
            except BaseException:  # noqa: BLE001 — graceful shutdown (CancelledError и пр.)
                pass


app = FastAPI(title="Financial Terminal API", lifespan=lifespan)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Главная страница
@app.get("/")
async def root():
    return FileResponse(FRONTEND_PATH / "index.html", headers={"Cache-Control": "no-cache"})


# Иконка сайта: без неё браузер просит /favicon.ico и запрос «висит»,
# из-за чего вкладка показывает бесконечную загрузку.
@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    icon = FRONTEND_PATH / "favicon.ico"
    if icon.exists():
        return FileResponse(icon)
    # Пустой ответ 204 вместо зависающего/бесконечного 404
    return Response(status_code=204)


# =============================================================================
# ЦЕНЫ (БЕЗ YAHOO FINANCE: MOEX + крипто CoinGecko)
# =============================================================================

@app.get("/api/prices/{symbol}", response_model=schemas.PriceResponse)
async def get_price(symbol: str):
    try:
        upper = symbol.upper()
        if upper.startswith("MOEX:"):
            return await moex_service.fetch_moex_price(upper.replace("MOEX:", ""))
        if upper.startswith("BINANCE:"):
            return await crypto_service.fetch_crypto_price(upper.replace("BINANCE:", ""))
        # Неизвестная биржа — считаем тикером Мосбиржи (Yahoo Finance не используется)
        return await moex_service.fetch_moex_price(upper)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# ПОРТФЕЛЬ
# =============================================================================

@app.get("/api/portfolio")
async def get_portfolio():
    return await portfolio_service.get_portfolio_with_pnl()


@app.post("/api/portfolio")
async def add_position_endpoint(position: schemas.PositionCreate):
    sector = getattr(position, 'sector', 'Не указан')
    return await portfolio_service.add_position(
        position.symbol,
        position.quantity,
        position.avg_price,
        sector
    )


@app.delete("/api/portfolio/{symbol}")
async def remove_position_endpoint(symbol: str):
    return await portfolio_service.remove_position(symbol)


# =============================================================================
# WATCHLIST - ХРАНЕНИЕ В БД
# =============================================================================

@app.get("/api/watchlist/{list_id}")
async def get_watchlist(list_id: str):
    """Возвращает список тикеров из БД в порядке позиции + название списка из БД.

    Если в watchlist_items есть элементы, а строки в watchlists нет (список
    появился до того, как названия стали храниться в БД, или не сохранилось
    название) — запись создаётся автоматически, чтобы таблицы были согласованы.
    """
    items = watchlist_service.get_list_symbols(list_id)
    name = watchlist_service.get_name(list_id)
    if name is None and items:
        watchlist_service.ensure_list(list_id)
        name = watchlist_service.get_name(list_id)
    return {
        "list_id": list_id,
        "name": name,
        # выбранный тикер списка — колонка БД watchlists.active_symbol
        # (раньше жил только в localStorage 'multi_watchlists_state')
        "active_symbol": watchlist_service.get_active_symbol(list_id),
        "symbols": [i["symbol"] for i in items],
        # расширенные данные: флажок/свёрнутость/заметка/разметка каждого элемента —
        # источник истины для избранного, свёрнутых разделов, заметок и разметки
        # графика (БД, а не localStorage)
        "items": [
            {
                "symbol": i["symbol"],
                "flag_color": i["flag_color"],
                "collapsed": i["collapsed"],
                "note": i.get("note"),
                "markup": i.get("markup"),
            }
            for i in items
        ],
    }


@app.get("/api/watchlists")
async def get_watchlists():
    """Возвращает все списки (id -> name) с названиями из БД."""
    return {"lists": watchlist_service.get_all_names()}


@app.get("/api/watchlist-flags")
async def get_watchlist_flags():
    """Все цветные флажки (избранное) из БД: {"list_id|SYMBOL": color}.

    Фронтенд вызывает при загрузке раздела WATCHLIST, чтобы восстановить
    избранное на любом браузере/устройстве.
    """
    return {"flags": watchlist_service.get_all_flags()}


@app.get("/api/watchlist-notes")
async def get_watchlist_notes():
    """Все непустые заметки к тикерам из БД: {"list_id|SYMBOL": note}.

    Аналог /api/watchlist-flags: фронтенд вызывает при загрузке раздела
    WATCHLIST, чтобы показать иконки 📝 со tooltip даже для списков, которые
    ещё не открывались в этой сессии.
    """
    return {"notes": watchlist_service.get_all_notes()}


@app.post("/api/watchlist/create")
async def create_watchlist(payload: schemas.WatchlistRename):
    """Создаёт список в таблице watchlists с указанным названием.

    Вызывается фронтендом сразу при создании нового списка, чтобы запись
    появилась в БД немедленно (а не только после добавления первого тикера).
    Если список уже существует — обновляет его название (upsert).
    """
    try:
        return watchlist_service.set_name(payload.list_id, payload.name)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))


@app.post("/api/watchlist/repair")
async def repair_watchlists(payload: schemas.WatchlistRepair):
    """Чинит строки-заглушки в watchlists («Новый список», list_<timestamp>).

    Фронтенд вызывает при загрузке раздела WATCHLIST: если локально у
    списка настоящее имя, а в БД заглушка — перезаписываем. Настоящие
    названия в БД не трогаем. Возвращает актуальные {id: name} после починки.
    """
    return {"lists": watchlist_service.repair_names(payload.names)}


@app.post("/api/watchlist/rename")
async def rename_watchlist(payload: schemas.WatchlistRename):
    """Переименовывает список: название сохраняется в БД (watchlists.name)."""
    try:
        return watchlist_service.set_name(payload.list_id, payload.name)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))


@app.post("/api/watchlist/active")
async def set_watchlist_active(payload: schemas.WatchlistActive):
    """Запоминает выбранный тикер списка в БД (watchlists.active_symbol).

    Раньше activeSymbol был частью appState в localStorage
    ('multi_watchlists_state') — втором источнике истины. Теперь выбор
    живёт на сервере и возвращается GET /api/watchlist/{list_id}.
    """
    return watchlist_service.set_active_symbol(payload.list_id, payload.symbol)


@app.delete("/api/watchlist/{list_id}")
async def delete_watchlist(list_id: str):
    """Удаляет список и его элементы из БД."""
    return watchlist_service.delete_list(list_id)


@app.post("/api/watchlist/add")
async def add_watchlist_ticker(payload: schemas.WatchlistAdd):
    """Добавляет тикер в watchlist (сохраняется в БД).

    list_name (если передан) используется, чтобы при автосоздании строки в
    watchlists сразу записывалось настоящее название списка с UI.
    """
    try:
        return watchlist_service.add_symbol(payload.list_id, payload.symbol, payload.list_name)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))


@app.post("/api/watchlist/remove")
async def remove_watchlist_ticker(payload: schemas.WatchlistRemove):
    """Удаляет тикер из watchlist (удаляется из БД)."""
    result = watchlist_service.remove_symbol(payload.list_id, payload.symbol)
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Тикер не найден в списке")
    return result


@app.post("/api/watchlist/move")
async def move_watchlist_ticker(payload: schemas.WatchlistMove):
    """Перемещает один элемент списка (drag&drop) без перезаписи всего состава.

    Сервер читает актуальный порядок из БД и вставляет перемещаемый символ на
    target_index — поэтому одновременные правки с двух устройств не затирают
    друг друга, а payload остаётся маленьким на списках любого размера.
    Возвращает новый порядок (symbols), чтобы фронтенд мог сверить UI с БД.
    """
    try:
        result = watchlist_service.move_symbol(
            payload.list_id, payload.symbol, payload.target_index
        )
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Тикер не найден в списке")
    return result


@app.post("/api/watchlist/order")
async def set_watchlist_order(payload: schemas.WatchlistOrder):
    """Сохраняет новый порядок/состав списка (разделы, импорт, миграция).

    Для обычного drag&drop предпочтителен /api/watchlist/move — он передаёт
    только перемещённый элемент и не затирает параллельные изменения других
    устройств. /order остаётся для операций, где состав действительно меняется
    целиком (добавление/удаление раздела, переименование, импорт бэкапа).

    Флажки и свёрнутость существующих элементов сохраняются в БД автоматически;
    через items можно передать flag_color/collapsed для новых элементов.
    """
    items = [i.model_dump() for i in payload.items] if payload.items else None
    return watchlist_service.set_order(payload.list_id, payload.symbols, payload.list_name, items)


@app.post("/api/watchlist/flag")
async def set_watchlist_flag(payload: schemas.WatchlistFlag):
    """Ставит/снимает цветной флажок (избранное) у элемента списка.

    Флаг хранится в колонке watchlist_items.flag_color — избранное больше не
    зависит от localStorage и переживает смену браузера/устройства.
    """
    try:
        result = watchlist_service.set_flag(payload.list_id, payload.symbol, payload.color)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Тикер не найден в списке")
    return result


@app.post("/api/watchlist/collapse")
async def set_watchlist_collapse(payload: schemas.WatchlistCollapse):
    """Запоминает состояние свёрнутого раздела (SECTION:...) в БД."""
    try:
        result = watchlist_service.set_collapsed(payload.list_id, payload.symbol, payload.collapsed)
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Раздел не найден в списке")
    return result


@app.post("/api/watchlist/note")
async def set_watchlist_note(payload: schemas.WatchlistNote):
    """Ставит/обновляет/снимает текстовую заметку к тикеру элемента списка.

    Заметка хранится в колонке watchlist_items.note — тезисы «почему слежу»
    больше не зависят от localStorage и переживают смену браузера/устройства.
    Пустая строка/null снимает заметку; длиннее NOTE_MAX_LEN — обрезается.
    """
    result = watchlist_service.set_note(payload.list_id, payload.symbol, payload.note)
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Тикер не найден в списке")
    return result


@app.post("/api/watchlist/markup")
async def set_watchlist_markup(payload: schemas.WatchlistMarkup):
    """Сохраняет разметку графика тикера (см. frontend/js/chart_overlay.js).

    Разметка — JSON-массив объектов (уровни/отметки по дате/текст), рисуемых
    на canvas-оверлее поверх TradingView-виджета. Хранится в колонке
    watchlist_items.markup — переживает смену браузера/устройства.
    Пустой массив/null очищает разметку; невалидный JSON -> 400.
    """
    try:
        result = watchlist_service.set_markup(payload.list_id, payload.symbol, payload.markup)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if result.get("status") == "not_found":
        raise HTTPException(status_code=404, detail="Тикер не найден в списке")
    return result


# =============================================================================
# ЦЕНОВЫЕ АЛЕРТЫ (таблица price_alerts; проверка условий — на бэкенде)
# =============================================================================

@app.get("/api/alerts")
async def get_alerts(symbol: str | None = Query(default=None),
                     status: str | None = Query(default=None)):
    """Список алертов из БД. Фильтры: ?symbol=MOEX:SBER&status=active."""
    try:
        return {"alerts": alert_service.list_alerts(symbol=symbol, status=status)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/alerts")
async def create_alert_endpoint(payload: schemas.AlertCreate):
    """Создаёт алерт и сохраняет его в таблицу price_alerts."""
    try:
        return alert_service.create_alert(
            payload.symbol, payload.condition, payload.target, payload.price_at_creation
        )
    except ValueError as ve:
        raise HTTPException(status_code=400, detail=str(ve))


@app.post("/api/alerts/{alert_id}/cancel")
async def cancel_alert_endpoint(alert_id: int):
    """Отменяет активный алерт (запись остаётся в истории со статусом 'cancelled')."""
    try:
        return alert_service.cancel_alert(alert_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Алерт не найден")


@app.delete("/api/alerts/{alert_id}")
async def delete_alert_endpoint(alert_id: int):
    """Полностью удаляет запись алерта из БД."""
    try:
        return alert_service.delete_alert(alert_id)
    except LookupError:
        raise HTTPException(status_code=404, detail="Алерт не найден")


@app.post("/api/alerts/check")
async def check_alerts_endpoint():
    """Принудительная проверка всех активных алертов против текущих цен.

    Вызывается фронтендом после каждой загрузки цен, чтобы мгновенно получить
    свежие статусы (звук/уведомление в браузере) не дожидаясь фонового цикла.
    Возвращает список сработавших за эту итерацию алертов.
    """
    try:
        return {"triggered": await alert_service.check_all_active()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/alerts/migrate")
async def migrate_alerts_endpoint(payload: schemas.AlertMigrate):
    """Переносит старые алерты из localStorage ('price_alerts') в БД.

    Фронтенд вызывает один раз при первой загрузке, если в localStorage
    остались записи клиентской версии; после успешного переноса ключ очищается.
    """
    try:
        return alert_service.migrate_from_client(payload.alerts)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# =============================================================================
# НОВОСТИ (Telegram @newssmartlab)
# =============================================================================

@app.get("/api/news/telegram/{ticker}")
async def get_telegram_news(ticker: str, force_refresh: bool = Query(default=False)):
    """Новости из @newssmartlab по тикеру"""
    clean_ticker = ticker.replace("MOEX:", "").upper()

    news = await telegram_news_service.fetch_smartlab_telegram_news(
        clean_ticker,
        force_refresh=force_refresh
    )
    return {"symbol": f"MOEX:{clean_ticker}", "news": news}


# === ИЗБРАННЫЕ НОВОСТИ (вкладка «Новости» раздела WATCHLIST) ===
# Флажок 🚩 ставится слева от конкретной новости; идентификатор новости —
# постоянная ссылка на пост в Telegram. Хранится в БД (news_favorites),
# поэтому избранное не теряется при смене браузера/устройства.

@app.get("/api/news/favorites")
async def get_news_favorites(ticker: str | None = Query(default=None)):
    """Избранные новости: {link: {"ticker": ..., "title": ...}}.

    С параметром ticker — только флажки выбранного тикера (лента новостей
    и вкладка «Избранные» работают индивидуально по каждому тикеру);
    без него — все избранные новости (для видимости вкладки «Избранные»).
    """
    return {"favorites": news_favorites_service.get_all(ticker)}


# === ФОНОВОЕ ОБНОВЛЕНИЕ НОВОСТНОГО КЭША (для избранных новостей) ===
# Вкладка «🚩 Избранные новости» раздела Watchlist тянет заголовки/время
# постов напрямую из таблицы news_cache (см. news_favorites_service), НЕ
# дожидаясь, пока пользователь откроет вкладку «Новости». Чтобы базе было
# что отдать даже когда ленту никто не запрашивал, вотчер в фоне парсит
# последние посты @newssmartlab в общий кэш (ticker=''). Обычные запросы
# вкладки «Новости» при этом идут как раньше — через свой ticker-кэш.
NEWS_STREAM_TICKER = ""            # строка кэша с общим потоком новостей
NEWS_STREAM_REFRESH_SECONDS = 300  # 5 минут — тот же TTL, что у ticker-кэша


async def _news_stream_watcher(stop_event: asyncio.Event) -> None:
    """Периодически обновляет общий новостной поток в БД, пока работает сервер."""
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(),
                                   timeout=NEWS_STREAM_REFRESH_SECONDS)
            return  # сервер останавливается — выходим без лишнего парсинга
        except asyncio.TimeoutError:
            pass
        try:
            posts = await telegram_news_service.fetch_smartlab_telegram_news(
                NEWS_STREAM_TICKER
            )
            if posts:
                print(f"🛰 Фоновое обновление потока новостей: {len(posts)} постов в БД")
        except Exception as e:  # сеть/парсер могли упасть — следующий цикл повторит
            print(f"⚠ Фоновое обновление потока новостей не удалось: {e}")


@app.get("/api/news/favorites/list")
async def get_news_favorites_list(ticker: str | None = Query(default=None)):
    """Избранные новости списком для вкладки «Избранные Новости».

    ticker — выбранный тикер: возвращаются только его избранные новости.
    Данные берутся НАПРЯМУЮ из БД (news_favorites + news_cache): вкладке не
    нужно дожидаться загрузки ленты во вкладке «Новости» — заголовки и время
    постов подтягиваются из кэша, а сам кэш дополнительно наполняется фоном
    (_news_stream_watcher). Записи отсортированы (свежие сверху).
    """
    return {"news": news_favorites_service.list_favorites(ticker)}


@app.post("/api/news/favorite")
async def toggle_news_favorite(payload: schemas.NewsFavoriteToggle):
    """Ставит/снимает красный флажок «избранное» у новости."""
    link = (payload.link or "").strip()
    if not link:
        raise HTTPException(status_code=400, detail="Пустая ссылка на новость")
    if payload.favorite:
        return news_favorites_service.set_favorite(link, payload.ticker, payload.title)
    result = news_favorites_service.remove_favorite(link)
    if result.get("status") == "not_found":
        # снятие уже снятого флажка — не ошибка, идемпотентный no-op
        return {"status": "ok", "link": link, "favorite": False}
    return result


if __name__ == "__main__":
    import uvicorn

    # ВАЖНО: приложение передаётся import-строкой, иначе uvicorn не может
    # включить reload/workers ("You must pass the application as an import string")
    uvicorn.run("backend.main:app", host="127.0.0.1", port=8000)
