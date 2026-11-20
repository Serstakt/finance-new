"""Сервис накопления свечей «Тест график» в БД (SQLite через SQLAlchemy).

История свечей накапливается по каждому (тикер, таймфрейм) независимо:
всё, что пришло из API (MOEX ISS / Binance klines), сохраняется через
bulk-upsert — существующие свечи обновляются (последняя «формирующаяся»
свеча корректируется), новые вставляются. Повторные загрузки не плодят
строки: PK candle_bars = (ticker_id, interval, begin).

Схема нормализована (три таблицы):
  * candle_tickers    — справочник тикеров (id <-> symbol);
  * candle_timeframes — реестр (тикер × ТФ): last_begin/candle_count/…,
    чтобы докачка и счётчики НЕ агрегировали большую таблицу;
  * candle_bars       — сами свечи, единственная «объёмная» таблица.

Инкрементальный флоу эндпоинта: get_last_begin() из реестра → в API уходит
from = дата последней сохранённой свечи (inclusive) → upsert → ответ
собирается из БД, т.е. клиент всегда получает ПОЛНУЮ накопленную историю.
"""
from datetime import datetime

from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from backend.database.database import get_session, safe_create_all
from backend.database.models import CandleBar, CandleTicker, CandleTimeframe

safe_create_all()

# Свечи вставляются чанками: один INSERT из N строк несёт N × 9 связанных
# параметров, а лимит переменных SQLite (SQLITE_MAX_VARIABLE_NUMBER) в старых
# сборках равен 999 — чанк 100 строк (900 параметров) безопасен везде.
UPSERT_CHUNK = 100


def _normalize_symbol(symbol: str) -> str:
    """' moex:SBER ' -> 'MOEX:SBER' (верхний регистр, без пробелов)."""
    return (symbol or "").strip().upper()


def _get_or_create_ticker(db, symbol: str) -> CandleTicker:
    """Возвращает запись тикера, создавая при отсутствии (идемпотентно)."""
    row = db.query(CandleTicker).filter(CandleTicker.symbol == symbol).one_or_none()
    if row:
        return row
    # гонка двух одновременных запросов: on_conflict_do_nothing + перечитывание
    db.execute(
        sqlite_insert(CandleTicker).values(symbol=symbol).on_conflict_do_nothing(
            index_elements=["symbol"]
        )
    )
    db.flush()
    return db.query(CandleTicker).filter(CandleTicker.symbol == symbol).one()


def _upsert_bars(db, ticker_id: int, interval: int, candles: list[dict]) -> int:
    """Bulk-upsert свечей в candle_bars. Возвращает число затронутых строк."""
    affected = 0
    for start in range(0, len(candles), UPSERT_CHUNK):
        chunk = candles[start:start + UPSERT_CHUNK]
        values = [{
            "ticker_id": ticker_id,
            "interval": interval,
            "begin": str(c["begin"]),
            "open": float(c["open"]),
            "high": float(c["high"]),
            "low": float(c["low"]),
            "close": float(c["close"]),
            "volume": float(c["volume"]) if c.get("volume") is not None else None,
            "value": float(c["value"]) if c.get("value") is not None else None,
            "end": str(c["end"]) if c.get("end") is not None else None,
        } for c in chunk]
        stmt = sqlite_insert(CandleBar).values(values)
        stmt = stmt.on_conflict_do_update(
            index_elements=["ticker_id", "interval", "begin"],
            set_={
                "open": stmt.excluded.open,
                "high": stmt.excluded.high,
                "low": stmt.excluded.low,
                "close": stmt.excluded.close,
                "volume": stmt.excluded.volume,
                "value": stmt.excluded.value,
                "end": stmt.excluded.end,
            },
        )
        affected += db.execute(stmt).rowcount or 0
    return affected


def _count_series(db, ticker_id: int, interval: int) -> int:
    """Число свечей конкретного (тикер, ТФ).

    Фильтр по префиксу PK (ticker_id, interval, begin) — это range-скан по
    индексу только своей серии, а не агрегация всей таблицы: при накоплении
    многих тикеров цена запроса зависит от размера ОДНОГО (тикер, ТФ).
    """
    return db.query(CandleBar.begin).filter(
        CandleBar.ticker_id == ticker_id,
        CandleBar.interval == interval,
    ).count()


def _upsert_timeframe_row(db, ticker_id: int, interval: int) -> None:
    """Обновляет реестр (тикер × ТФ): last_begin + candle_count + штамп времени."""
    last_begin = db.query(CandleBar.begin).filter(
        CandleBar.ticker_id == ticker_id,
        CandleBar.interval == interval,
    ).order_by(CandleBar.begin.desc()).limit(1).scalar()
    count = _count_series(db, ticker_id, interval)
    stmt = sqlite_insert(CandleTimeframe).values(
        ticker_id=ticker_id,
        interval=interval,
        last_begin=last_begin,
        candle_count=count,
        last_fetched_at=datetime.utcnow(),
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=["ticker_id", "interval"],
        set_={
            "last_begin": last_begin,
            "candle_count": count,
            "last_fetched_at": datetime.utcnow(),
        },
    )
    db.execute(stmt)


def save_candles(symbol: str, interval: int, candles: list[dict]) -> dict:
    """Сохраняет свечи одного (тикер, ТФ) в БД: upsert bars + реестр.

    candles — формат ответа moex_service / crypto_service:
    [{open, high, low, close, volume, value, begin, end}, …].
    Возвращает {ticker_id, saved, candle_count, last_begin}.
    """
    symbol = _normalize_symbol(symbol)
    if not candles:
        return {"status": "nothing_to_save", "ticker_id": None,
                "candle_count": 0, "last_begin": None}

    with get_session() as db:
        ticker = _get_or_create_ticker(db, symbol)
        affected = _upsert_bars(db, ticker.id, interval, candles)
        _upsert_timeframe_row(db, ticker.id, interval)
        db.commit()
        count = db.query(CandleTimeframe.candle_count).filter(
            CandleTimeframe.ticker_id == ticker.id,
            CandleTimeframe.interval == interval,
        ).scalar()
        last_begin = db.query(CandleTimeframe.last_begin).filter(
            CandleTimeframe.ticker_id == ticker.id,
            CandleTimeframe.interval == interval,
        ).scalar()
        return {
            "status": "ok",
            "ticker_id": ticker.id,
            "affected": affected,
            "candle_count": count,
            "last_begin": last_begin,
        }


def _resolve_ticker_id(db, symbol: str) -> int | None:
    return db.query(CandleTicker.id).filter(
        CandleTicker.symbol == symbol
    ).scalar()


def get_last_begin(symbol: str, interval: int) -> str | None:
    """begin последней сохранённой свечи (из реестра, без обращения к bars).

    None — этот (тикер, ТФ) ещё не копился: эндпоинт тогда запросит у API
    полную историю.
    """
    symbol = _normalize_symbol(symbol)
    with get_session() as db:
        ticker_id = _resolve_ticker_id(db, symbol)
        if ticker_id is None:
            return None
        return db.query(CandleTimeframe.last_begin).filter(
            CandleTimeframe.ticker_id == ticker_id,
            CandleTimeframe.interval == interval,
        ).scalar()


def load_candles(symbol: str, interval: int) -> list[dict]:
    """Вся накопленная история (тикер, ТФ) из candle_bars, по возрастанию begin.

    Формат строк совпадает с форматом API-ответов (open/close/…/begin/end),
    поэтому эндпоинт и фронтенд работают с обоими источниками одинаково.
    """
    symbol = _normalize_symbol(symbol)
    with get_session() as db:
        ticker_id = _resolve_ticker_id(db, symbol)
        if ticker_id is None:
            return []
        rows = db.query(CandleBar).filter(
            CandleBar.ticker_id == ticker_id,
            CandleBar.interval == interval,
        ).order_by(CandleBar.begin.asc()).all()
        return [{
            "open": r.open, "high": r.high, "low": r.low, "close": r.close,
            "volume": r.volume, "value": r.value,
            "begin": r.begin, "end": r.end,
        } for r in rows]


def stored_candle_counts(symbol: str) -> dict[int, int]:
    """Счётчики накопленных свечей по всем ТФ тикера (только реестр)."""
    symbol = _normalize_symbol(symbol)
    with get_session() as db:
        ticker_id = _resolve_ticker_id(db, symbol)
        if ticker_id is None:
            return {}
        rows = db.query(CandleTimeframe.interval, CandleTimeframe.candle_count).filter(
            CandleTimeframe.ticker_id == ticker_id,
        ).all()
        return {interval: count for interval, count in rows}
