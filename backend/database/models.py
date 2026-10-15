from sqlalchemy import Boolean, Column, String, Integer, Float, DateTime, Text
from datetime import datetime
from .database import Base


class NewsCache(Base):
    __tablename__ = "news_cache"

    ticker = Column(String, primary_key=True, index=True)
    news_data = Column(Text)
    timestamp = Column(DateTime, default=datetime.utcnow)


class WatchlistItem(Base):
    """Тикер watchlist, привязанный к конкретному списку.

    flag_color — цвет флажка «избранного» (red/blue/yellow/orange/green) или None.
    collapsed — признак свёрнутого раздела (SECTION:...).
    note — пользовательская заметка/комментарий к тикеру (тезис «почему слежу»),
    хранится в TEXT, до NOTE_MAX_LEN символов.
    Раньше флажки, свёрнутость и заметки жили только в localStorage браузера;
    теперь это колонки БД, поэтому они не теряются при смене браузера/устройства.
    """
    __tablename__ = "watchlist_items"

    id = Column(Integer, primary_key=True, autoincrement=True)
    list_id = Column(String, nullable=False, index=True, default="default")
    symbol = Column(String, nullable=False, index=True)
    position = Column(Integer, nullable=False, default=0)
    flag_color = Column(String, nullable=True)
    collapsed = Column(Boolean, nullable=False, default=False)
    note = Column(Text, nullable=True)
    added_at = Column(DateTime, default=datetime.utcnow)


class Watchlist(Base):
    """Список watchlist: id -> название (хранится в БД, а не в localStorage)."""
    __tablename__ = "watchlists"

    id = Column(String, primary_key=True)
    name = Column(String, nullable=False, default="Основной")
    created_at = Column(DateTime, default=datetime.utcnow)


class PriceAlert(Base):
    """Ценовой алерт (раньше хранился в localStorage 'price_alerts').

    Статусы: 'active' (ожидает срабатывания), 'triggered' (сработал),
    'cancelled' (отменён вручную). Проверка условий выполняется на бэкенде
    (services/alert_service.py), поэтому алерты живут и проверяются даже
    при закрытой вкладке браузера.
    """
    __tablename__ = "price_alerts"

    id = Column(Integer, primary_key=True, autoincrement=True)
    symbol = Column(String, nullable=False, index=True)
    condition = Column(String, nullable=False, default="above")  # above | below
    target = Column(Float, nullable=False)
    status = Column(String, nullable=False, default="active", index=True)
    price_at_creation = Column(Float, nullable=True)   # цена на момент создания
    triggered_price = Column(Float, nullable=True)     # цена срабатывания
    created_at = Column(DateTime, default=datetime.utcnow)
    triggered_at = Column(DateTime, nullable=True)
