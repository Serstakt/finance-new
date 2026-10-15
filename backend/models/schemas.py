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
    """Расширенный элемент для /order: порядок + флажок/свёрнутость."""
    symbol: str
    flag_color: Optional[str] = None
    collapsed: Optional[bool] = None


class WatchlistOrder(BaseModel):
    list_id: str = "default"
    symbols: List[str]
    # См. WatchlistAdd: настоящее название списка при автосоздании строки в watchlists.
    list_name: str | None = None
    # Необязательные метаданные (flag_color/collapsed) — нужны, чтобы при
    # пересоздании строк флажки не терялись. Для существующих элементов БД
    # значения сохраняются автоматически, даже если items не передан.
    items: Optional[List[WatchlistOrderItem]] = None


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


class WatchlistRename(BaseModel):
    list_id: str = "default"
    name: str


class WatchlistRepair(BaseModel):
    """Массовая починка названий: {list_id: настоящее_название}.

    Фронтенд вызывает POST /api/watchlist/repair при загрузке раздела
    WATCHLIST, чтобы залечить строки-заглушки («Новый список»,
    list_<timestamp>), созданные гонкой add-before-create.
    Настоящие пользовательские названия не перезаписываются.
    """
    names: Dict[str, str]


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

