from sqlalchemy import Column, String, Float
from backend.database.database import Base, engine, get_session, safe_create_all
from backend.services import moex_service, crypto_service


class Position(Base):
    __tablename__ = 'positions'
    symbol = Column(String, primary_key=True)
    quantity = Column(Float, nullable=False)
    avg_price = Column(Float, nullable=False)
    sector = Column(String, nullable=True, default="Не указан")

safe_create_all()


async def get_portfolio_with_pnl() -> dict:
    with get_session() as db:
        positions = db.query(Position).all()

    result = []
    total_value = 0
    total_invested = 0

    print("\n=== НАЧАЛО РАСЧЕТА ПОРТФЕЛЯ ===")
    for pos in positions:
        # 1. Очищаем символ от пробелов и приводим к верхнему регистру
        clean_symbol = pos.symbol.replace(" ", "").upper()
        print(f"➡️ Обработка: {clean_symbol} | Кол-во: {pos.quantity} | Ср. цена: {pos.avg_price}")

        current_price = pos.avg_price  # Заглушка по умолчанию

        try:
            if clean_symbol.startswith("MOEX:"):
                ticker = clean_symbol.replace("MOEX:", "")
                price_data = await moex_service.fetch_moex_price(ticker)
            elif clean_symbol.startswith("BINANCE:"):
                ticker = clean_symbol.replace("BINANCE:", "")
                price_data = await crypto_service.fetch_crypto_price(ticker)
            else:
                # Yahoo Finance не используется — считаем тикером Мосбиржи
                price_data = await moex_service.fetch_moex_price(clean_symbol)

            print(f"   📡 Ответ от API: {price_data}")

            if price_data and price_data.get("price"):
                current_price = price_data["price"]
                print(f"   ✅ Успех! Текущая цена установлена: {current_price}")
            else:
                print(f"   ⚠️ В ответе API нет ключа 'price'. Используем среднюю цену.")

        except Exception as e:
            print(f"   ❌ ОШИБКА получения цены для {clean_symbol}: {e}")

        # 2. Считаем метрики
        invested = pos.quantity * pos.avg_price
        current_val = pos.quantity * current_price
        pnl = current_val - invested
        pnl_pct = (pnl / invested * 100) if invested > 0 else 0

        print(f"   🧮 Инвестировано: {invested} | Текущая ст-сть: {current_val} | P&L: {pnl} ({pnl_pct}%)")

        total_value += current_val
        total_invested += invested

        result.append({
            "symbol": clean_symbol,
            "quantity": pos.quantity,
            "avg_price": pos.avg_price,
            "current_price": current_price,
            "pnl": round(pnl, 2),
            "pnl_pct": round(pnl_pct, 2),
            "sector": pos.sector
        })

    total_pnl = total_value - total_invested
    total_pnl_pct = (total_pnl / total_invested * 100) if total_invested > 0 else 0

    print(f"=== ИТОГО: P&L = {total_pnl} ({total_pnl_pct}%) ===\n")

    return {
        "positions": result,
        "total_value": round(total_value, 2),
        "total_invested": round(total_invested, 2),
        "total_pnl": round(total_pnl, 2),
        "total_pnl_pct": round(total_pnl_pct, 2)
    }


async def add_position(symbol: str, quantity: float, avg_price: float, sector: str = "Не указан") -> dict:
    clean_symbol = symbol.replace(" ", "").upper()
    try:
        with get_session() as db:
            existing = db.query(Position).filter_by(symbol=clean_symbol).first()

            if existing:
                total_qty = existing.quantity + quantity
                existing.avg_price = ((existing.quantity * existing.avg_price + quantity * avg_price) / total_qty)
                existing.quantity = total_qty
                existing.sector = sector
            else:
                db.add(Position(symbol=clean_symbol, quantity=quantity, avg_price=avg_price, sector=sector))

            db.commit()
            return {"status": "ok", "symbol": clean_symbol}
    except Exception as e:
        return {"status": "error", "message": str(e)}


async def remove_position(symbol: str) -> dict:
    # Очищаем символ от пробелов и приводим к верхнему регистру
    clean_symbol = symbol.replace(" ", "").upper()
    print(f"🗑️ Попытка удалить позицию: '{clean_symbol}' (исходный: '{symbol}')")

    with get_session() as db:
        # Ищем позицию
        position = db.query(Position).filter_by(symbol=clean_symbol).first()

        if position:
            print(f"   ✅ Найдена позиция: {position.symbol}")
            db.delete(position)
            db.commit()
            print(f"   ✅ Позиция удалена")
            return {"status": "ok", "symbol": clean_symbol}
        else:
            print(f"   ❌ Позиция '{clean_symbol}' не найдена в базе данных")
            # Попробуем найти все позиции для отладки
            all_positions = db.query(Position).all()
            print(f"   📋 Все позиции в базе: {[p.symbol for p in all_positions]}")
            return {"status": "error", "message": f"Position {clean_symbol} not found"}
