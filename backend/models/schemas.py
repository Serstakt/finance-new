from pydantic import BaseModel
from typing import Dict, Any, Optional, List


class PriceResponse(BaseModel):
    symbol: str
    price: float | None = None
    changeDay: float | None = None
    changeValue: float | None = None
    changeWeek: float | None = None
    changeMonth: float | None = None
    changeYear: float | None = None
    # Логотип монеты (CoinGecko image, поле приходит из /coins/markets).
    # Для MOEX-тикеров может приходить favicon с сайта эмитента или None.
    logo: str | None = None


class PositionCreate(BaseModel):
    symbol: str
    quantity: float
    avg_price: float
    sector: str = "Не указан"


class WatchlistAdd(BaseModel):
    list_id: str = "default"
    symbol: str
    # Название списка (опционально): передаётся фронтендом, чтобы при добавлении
    # тикера в ещё не созданный список запись в watchlists появлялась сразу с
    # настоящим именем, а не с заглушкой (закрывает гонку create/add).
    list_name: str | None = None


class WatchlistRemove(BaseModel):
    list_id: str = "default"
    symbol: str


class WatchlistOrderItem(BaseModel):
    """Расширенный элемент для /order: порядок + флажок/свёрнутость/заметка."""
    symbol: str
    flag_color: Optional[str] = None
    collapsed: Optional[bool] = None
    note: Optional[str] = None


class WatchlistOrder(BaseModel):
    list_id: str = "default"
    symbols: List[str]
    # См. WatchlistAdd: настоящее название списка при автосоздании строки в watchlists.
    list_name: str | None = None
    # Необязательные метаданные (flag_color/collapsed/note) — нужны, чтобы при
    # пересоздании строк флажки и заметки не терялись. Для существующих элементов
    # БД значения сохраняются автоматически, даже если items не передан.
    items: Optional[List[WatchlistOrderItem]] = None


class WatchlistMove(BaseModel):
    """Точечное перемещение одного элемента списка (drag&drop).

    В отличие от /order, который перезаписывает весь список целиком, здесь
    передаётся только перемещённый символ и его новая позиция относительно
    актуального состава списка в БД. Это снимает и проблему размера payload
    на больших списках, и гонку двух устройств: сервер переставляет элемент
    поверх текущего состояния, а не затирает его снимком со своей стороны.
    """
    list_id: str = "default"
    symbol: str
    # Новая позиция элемента в списке (0..len-1), считанная фронтендом после
    # drop по актуальному DOM. Значение вне диапазона прижимается к краям.
    target_index: int


class WatchlistFlag(BaseModel):
    """Постановка/снятие цветного флажка (избранное) у элемента списка."""
    list_id: str = "default"
    symbol: str
    # red/blue/yellow/orange/green либо None/"" — снять флажок
    color: Optional[str] = None


class WatchlistCollapse(BaseModel):
    """Сохранение состояния свёрнутого раздела (SECTION:...) в БД."""
    list_id: str = "default"
    symbol: str  # SECTION:<название>
    collapsed: bool = True


class WatchlistNote(BaseModel):
    """Постановка/обновление/снятие текстовой заметки к тикеру элемента списка.

    note=None/"" очищает заметку; иначе сохраняется в watchlist_items.note
    (обрезается до NOTE_MAX_LEN символов на бэкенде).
    """
    list_id: str = "default"
    symbol: str
    note: Optional[str] = None


class WatchlistMarkup(BaseModel):
    """Сохранение разметки графика (уровни/отметки/текст) для тикера.

    markup — JSON-массив объектов вида [{id,type,price|time|text,color}]
    (формат см. frontend/js/chart_overlay.js); хранится как текст в
    watchlist_items.markup. None/""/"[]" очищает разметку.
    """
    list_id: str = "default"
    symbol: str
    markup: Optional[str] = None


class WatchlistRename(BaseModel):
    list_id: str = "default"
    name: str


class WatchlistActive(BaseModel):
    """Сохранение выбранного тикера списка (watchlists.active_symbol).

    Раньше activeSymbol жил в appState -> localStorage ('multi_watchlists_state');
    теперь источник истины — БД, чтобы не было двух синхронизируемых копий.
    """
    list_id: str = "default"
    symbol: Optional[str] = None


class WatchlistRepair(BaseModel):
    """Массовая починка названий: {list_id: настоящее_название}.

    Фронтенд вызывает POST /api/watchlist/repair при загрузке раздела
    WATCHLIST, чтобы залечить строки-заглушки («Новый список»,
    list_<timestamp>), созданные гонкой add-before-create.
    Настоящие пользовательские названия не перезаписываются.
    """
    names: Dict[str, str]


# === ИЗБРАННЫЕ НОВОСТИ (вкладка «Новости» раздела WATCHLIST) ===

class NewsFavoriteToggle(BaseModel):
    """Отметка/снятие флага «избранное» у конкретной новости.

    link — постоянная ссылка на пост в Telegram (https://t.me/newssmartlab/<id>),
    используется как идентификатор новости; favorite=True ставит красный флажок
    слева от новости, favorite=False снимает его.
    """
    link: str
    favorite: bool = True
    ticker: Optional[str] = None   # тикер, по которому найдена новость
    title: Optional[str] = None    # текст заголовка для отображения вне контекста


# === ЦЕНОВЫЕ АЛЕРТЫ (хранятся в БД, таблица price_alerts) ===

class AlertCreate(BaseModel):
    symbol: str
    condition: str = "above"          # above | below
    target: float
    # Текущая цена на момент создания (сохраняется в price_at_creation
    # для отображения «от какой цены ждали»).
    price_at_creation: Optional[float] = None


class AlertMigrate(BaseModel):
    """Перенос старых алертов из localStorage ('price_alerts') в БД.

    legacy-формат записи: {id, symbol, condition, target, active, status?, cancelled?}
    """
    alerts: List[Dict[str, Any]]


# === PUSH-УВЕДОМЛЕНИЯ О СРАБОТАВШИХ АЛЕРТАХ (Telegram-бот) ===

class NotificationTest(BaseModel):
    """Необязательное тело для POST /api/notifications/test — свой текст."""
    text: Optional[str] = None

