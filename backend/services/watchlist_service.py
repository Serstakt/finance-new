"""Сервис хранения watchlist в БД (SQLite через SQLAlchemy).

Каждая запись — это строка (list_id, symbol, position) в таблице watchlist_items.
Символы вида SECTION:... (заголовки разделов) тоже хранятся как элементы списка,
чтобы сохранять порядок и группировку.
"""
from backend.database.database import Base, engine, get_session, safe_create_all
from backend.database.models import WatchlistItem

safe_create_all()


def get_list_symbols(list_id: str) -> list[dict]:
    """Возвращает элементы списка в порядке позиции."""
    with get_session() as db:
            rows = (
                db.query(WatchlistItem)
                .filter(WatchlistItem.list_id == list_id)
                .order_by(WatchlistItem.position.asc(), WatchlistItem.id.asc())
                .all()
            )
            return [{"symbol": r.symbol, "position": r.position} for r in rows]


def add_symbol(list_id: str, symbol: str) -> dict:
    """Добавляет тикер в конец списка. Повтор не добавляется (идемпотентно)."""
    symbol = symbol.strip()
    if not symbol:
        raise ValueError("Пустой символ")

    with get_session() as db:
            existing = (
                db.query(WatchlistItem)
                .filter(WatchlistItem.list_id == list_id, WatchlistItem.symbol == symbol)
                .first()
            )
            if existing:
                return {"status": "exists", "list_id": list_id, "symbol": symbol}

            max_pos = db.query(WatchlistItem.position).filter(
                WatchlistItem.list_id == list_id
            ).order_by(WatchlistItem.position.desc()).first()
            next_pos = (max_pos[0] + 1) if max_pos else 0

            db.add(WatchlistItem(list_id=list_id, symbol=symbol, position=next_pos))
            db.commit()
            return {"status": "ok", "list_id": list_id, "symbol": symbol, "position": next_pos}


def remove_symbol(list_id: str, symbol: str) -> dict:
    """Удаляет тикер из списка и перенумеровывает позиции."""
    symbol = symbol.strip()
    with get_session() as db:
            row = (
                db.query(WatchlistItem)
                .filter(WatchlistItem.list_id == list_id, WatchlistItem.symbol == symbol)
                .first()
            )
            if not row:
                return {"status": "not_found", "list_id": list_id, "symbol": symbol}

            db.delete(row)
            db.flush()
            # перенумерация оставшихся, чтобы позиции были плотными 0..n-1
            remaining = (
                db.query(WatchlistItem)
                .filter(WatchlistItem.list_id == list_id)
                .order_by(WatchlistItem.position.asc(), WatchlistItem.id.asc())
                .all()
            )
            for i, item in enumerate(remaining):
                item.position = i
            db.commit()
            return {"status": "ok", "list_id": list_id, "symbol": symbol}


def set_order(list_id: str, symbols: list[str]) -> dict:
    """Заменяет содержимое/порядок списка на переданный (используется для drag&drop)."""
    cleaned = [s.strip() for s in symbols if s and s.strip()]
    with get_session() as db:
            old = db.query(WatchlistItem).filter(WatchlistItem.list_id == list_id).all()
            old_map = {r.symbol: r for r in old}
            wanted = set(cleaned)

            for sym, row in old_map.items():
                if sym not in wanted:
                    db.delete(row)
            db.flush()

            for i, sym in enumerate(cleaned):
                row = old_map.get(sym)
                if row:
                    row.position = i
                else:
                    db.add(WatchlistItem(list_id=list_id, symbol=sym, position=i))
            db.commit()
            return {"status": "ok", "list_id": list_id, "count": len(cleaned)}
