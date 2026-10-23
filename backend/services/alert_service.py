"""Сервис ценовых алертов watchlist (хранение и проверка на бэкенде).

Раньше алерты жили в localStorage браузера и проверялись только когда
вкладка открыта. Теперь они сохраняются в таблицу price_alerts, а условия
проверяет фоновый цикл на сервере (запускается из lifespan приложения):
алерт срабатывает даже при закрытом браузере, статусы переживают
перезагрузку страницы и смену устройства.

API сервиса:
- list_alerts / create_alert / cancel_alert / delete_alert — CRUD;
- check_all_active() — одна итерация проверки всех активных алертов
  (параллельно тянет цены через moex_service/crypto_service);
- migrate_from_client(payload) — одноразовый перенос алертов из
  localStorage фронтенда в БД;
- run_background_checker() — asyncio-цикл периодических проверок.
"""
import asyncio
import logging
from datetime import datetime

from backend.database.database import get_session, safe_create_all
from backend.database.models import PriceAlert
from backend.services import moex_service, crypto_service

logger = logging.getLogger(__name__)

safe_create_all()

VALID_CONDITIONS = {"above", "below"}
MAX_ALERTS_PER_SYMBOL = 10        # как в старой клиентской версии (trimAlertsHistory)
HISTORY_LIMIT_PER_SYMBOL = 50     # сколько записей истории храним на символ
CHECK_INTERVAL_SECONDS = 60       # период фоновой проверки


def _normalize_symbol(symbol: str) -> str:
    """Верхний регистр, как в watchlist_service.add_symbol."""
    return (symbol or "").strip().upper()


def _to_dict(a: PriceAlert) -> dict:
    return {
        "id": a.id,
        "symbol": a.symbol,
        "condition": a.condition,
        "target": a.target,
        "status": a.status,
        "price_at_creation": a.price_at_creation,
        "triggered_price": a.triggered_price,
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "triggered_at": a.triggered_at.isoformat() if a.triggered_at else None,
    }


def list_alerts(symbol: str | None = None, status: str | None = None) -> list[dict]:
    """Список алертов (можно отфильтровать по символу/статусу), новые сверху."""
    with get_session() as db:
        q = db.query(PriceAlert)
        if symbol:
            q = q.filter(PriceAlert.symbol == _normalize_symbol(symbol))
        if status:
            q = q.filter(PriceAlert.status == status)
        rows = q.order_by(PriceAlert.id.desc()).all()
        return [_to_dict(r) for r in rows]


def create_alert(symbol: str, condition: str, target: float,
                 price_at_creation: float | None = None) -> dict:
    """Создаёт активный алерт. Лимит MAX_ALERTS_PER_SYMBOL активных на символ."""
    symbol = _normalize_symbol(symbol)
    condition = (condition or "").strip().lower()
    if not symbol or symbol.startswith("SECTION:"):
        raise ValueError("Некорректный тикер")
    if condition not in VALID_CONDITIONS:
        raise ValueError("Условие должно быть 'above' или 'below'")
    try:
        target = float(target)
    except (TypeError, ValueError):
        raise ValueError("Некорректная целевая цена")
    if target <= 0:
        raise ValueError("Целевая цена должна быть больше нуля")

    with get_session() as db:
        active_count = (
            db.query(PriceAlert)
            .filter(PriceAlert.symbol == symbol, PriceAlert.status == "active")
            .count()
        )
        if active_count >= MAX_ALERTS_PER_SYMBOL:
            raise ValueError(f"Слишком много активных алертов для {symbol} (максимум {MAX_ALERTS_PER_SYMBOL})")

        alert = PriceAlert(
            symbol=symbol,
            condition=condition,
            target=target,
            status="active",
            price_at_creation=float(price_at_creation) if price_at_creation else None,
        )
        db.add(alert)
        db.commit()
        db.refresh(alert)
        return _to_dict(alert)


def cancel_alert(alert_id: int) -> dict:
    """Отменяет активный алерт (status='cancelled'), запись остаётся в истории."""
    with get_session() as db:
        alert = db.get(PriceAlert, alert_id)
        if not alert:
            raise LookupError("Алерт не найден")
        if alert.status == "active":
            alert.status = "cancelled"
            db.commit()
            db.refresh(alert)
        return _to_dict(alert)


def delete_alert(alert_id: int) -> dict:
    """Полностью удаляет запись алерта из БД."""
    with get_session() as db:
        alert = db.get(PriceAlert, alert_id)
        if not alert:
            raise LookupError("Алерт не найден")
        symbol = alert.symbol
        db.delete(alert)
        db.commit()
        return {"status": "ok", "id": alert_id, "symbol": symbol}


def trim_history() -> None:
    """Ограничивает историю: на символ хранится не более HISTORY_LIMIT_PER_SYMBOL
    записей в статусах triggered/cancelled (активные не удаляем никогда)."""
    with get_session() as db:
        symbols = [
            r[0] for r in
            db.query(PriceAlert.symbol).filter(PriceAlert.status != "active").distinct().all()
        ]
        for sym in symbols:
            old = (
                db.query(PriceAlert)
                .filter(PriceAlert.symbol == sym, PriceAlert.status != "active")
                .order_by(PriceAlert.id.desc())
                .offset(HISTORY_LIMIT_PER_SYMBOL)
                .all()
            )
            for row in old:
                db.delete(row)
        db.commit()


async def _fetch_price(symbol: str) -> float | None:
    """Цена для символа через существующие сервисы котировок (MOEX/CoinGecko)."""
    upper = symbol.upper()
    try:
        if upper.startswith("BINANCE:"):
            data = await crypto_service.fetch_crypto_price(upper.replace("BINANCE:", ""))
        elif upper.startswith("MOEX:"):
            data = await moex_service.fetch_moex_price(upper.replace("MOEX:", ""))
        else:
            data = await moex_service.fetch_moex_price(upper)
        price = data.get("price") if isinstance(data, dict) else getattr(data, "price", None)
        return float(price) if price is not None else None
    except Exception as exc:  # сеть/внешний API — не роняем цикл проверки
        logger.warning("Не удалось получить цену для %s: %s", symbol, exc)
        return None


async def check_all_active(price_map: dict[str, float] | None = None) -> list[dict]:
    """Проверяет все активные алерты против текущих цен; возвращает сработавшие.

    Сработавший алерт получает status='triggered', triggered_price и
    triggered_at — то есть переход в «исполнено» происходит на сервере и
    сохраняется в таблице, даже если браузер был закрыт.

    price_map — готовые цены {symbol: price} (например, снимок live-цикла SSE).
    Если передан, внешние API не дёргаются вовсе: недоступные символы просто
    пропускаются до следующего цикла. Без него — цены тянутся параллельно
    через _fetch_price (прежний путь REST /api/alerts/check и checker-а).
    """
    alerts = list_alerts(status="active")
    if not alerts:
        return []

    symbols = sorted({a["symbol"] for a in alerts})
    if price_map is None:
        prices = await asyncio.gather(*[_fetch_price(s) for s in symbols])
        price_map = dict(zip(symbols, prices))

    triggered: list[dict] = []
    with get_session() as db:
        for a in alerts:
            current = price_map.get(a["symbol"])
            if current is None:
                continue  # цена недоступна — пропускаем, проверим в следующем цикле
            hit = (a["condition"] == "above" and current >= a["target"]) or \
                  (a["condition"] == "below" and current <= a["target"])
            if not hit:
                continue
            row = db.get(PriceAlert, a["id"])
            if row and row.status == "active":
                row.status = "triggered"
                row.triggered_price = current
                row.triggered_at = datetime.utcnow()
                triggered.append({**a, "triggered_price": current})
        db.commit()

    if triggered:
        for t in triggered:
            logger.info("Алерт сработал: %s (%s %s), цена %s",
                        t["symbol"], t["condition"], t["target"], t["triggered_price"])
        trim_history()
    return triggered


def migrate_from_client(items: list[dict]) -> dict:
    """Одноразовый перенос алертов из localStorage ('price_alerts') в БД.

    Фронтенд вызывает POST /api/alerts/migrate при первой загрузке, если в
    localStorage есть старые записи, а затем очищает ключ. Дубликаты
    активных записей отсекаются по кортежу (symbol, condition, target).
    Уже погашенные legacy-записи переносятся сразу в финальный статус
    ('triggered'/'cancelled'), чтобы не плодить «залипшие» активные алерты.
    """
    imported = 0
    skipped = 0
    with get_session() as db:
        existing_keys = {
            (r.symbol, r.condition, round(float(r.target), 6))
            for r in db.query(PriceAlert).filter(PriceAlert.status == "active").all()
        }
        for item in items or []:
            try:
                symbol = _normalize_symbol(str(item.get("symbol", "")))
                condition = str(item.get("condition", "")).lower()
                target = float(item.get("target"))
            except (TypeError, ValueError):
                skipped += 1
                continue
            if not symbol or symbol.startswith("SECTION:") or \
                    condition not in VALID_CONDITIONS or target <= 0:
                skipped += 1
                continue

            # legacy-статус: active === false ⇒ 'cancelled' (если был флаг
            # cancelled) или 'triggered'; иначе берём status, фолбэк 'active'
            if item.get("active") is False:
                status = "cancelled" if item.get("cancelled") else "triggered"
            else:
                status = item.get("status") or "active"
            if status not in {"active", "triggered", "cancelled"}:
                status = "active"

            key = (symbol, condition, round(target, 6))
            if status == "active":
                if key in existing_keys:
                    skipped += 1
                    continue
                existing_keys.add(key)

            row = PriceAlert(symbol=symbol, condition=condition, target=target,
                             status=status)
            db.add(row)
            imported += 1
        db.commit()
    return {"imported": imported, "skipped": skipped}


async def run_background_checker(interval_seconds: int = CHECK_INTERVAL_SECONDS,
                                 stop_event: asyncio.Event | None = None,
                                 on_check=None) -> None:
    """Фоновый цикл: каждые interval_seconds проверяет активные алерты.

    Запускается как asyncio.Task из lifespan FastAPI-приложения. Ошибки одной
    итерации логируются и не убивают цикл.
    """
    stop_event = stop_event or asyncio.Event()
    logger.info("Фоновый checker алертов запущен (интервал %d с)", interval_seconds)
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
            break  # получен сигнал остановки
        except asyncio.TimeoutError:
            pass
        try:
            triggered = await check_all_active()
            # уведомляем подписчиков SSE о новых статусах (звук/колокольчики
            # приходят в браузер push-ем, без POST /api/alerts/check по таймеру)
            if on_check:
                try:
                    on_check()
                except Exception:  # noqa: BLE001 — уведомления не роняют checker
                    logger.exception("on_check колбэк live-потока упал")
            _ = triggered
        except Exception:  # noqa: BLE001 — цикл не должен умирать от сбоя проверки
            logger.exception("Ошибка в цикле проверки алертов")
    logger.info("Фоновый checker алертов остановлен")
