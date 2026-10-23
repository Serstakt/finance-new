"""Проверка push-уведомлений о сработавших алертах через Telegram-бота.

Что проверяется (без реального Telegram — сетевой слой подменяется заглушкой):
1. Конфигурация: без TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID уведомления «выключены»,
   notify_alert_triggered ничего не шлёт и не падает.
2. Формат сообщения: символ, направление условия, цена/цель, id алерта.
3. Интеграция с alert_service.check_all_active(): сработавший алерт (цена
   проброшена через мок moex_service) вызывает отправку ровно одного
   уведомления с корректным текстом.
4. Идемпотентность: повторный вызов для того же alert_id НЕ шлёт сообщение
   ещё раз (запись в alert_notification_log).
5. Сбой доставки (сеть/Telegram 5xx) не роняет проверку алертов: статус
   'triggered' сохраняется в БД, уведомление помечается как неотправленное.
"""
import asyncio
import os

from backend.database.database import get_session, safe_create_all
from backend.database.models import PriceAlert, AlertNotificationLog
from backend.services import alert_service, notification_service

safe_create_all()

failures = 0


def check(cond, msg):
    global failures
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


# --- Чистим таблицы, которые трогаем ---------------------------------------
with get_session() as db:
    db.query(PriceAlert).filter(PriceAlert.symbol.in_(["TESTPUSH", "TESTFAIL"])).delete(synchronize_session=False)
    db.query(AlertNotificationLog).delete()
    db.commit()

SENT: list[tuple[str, str]] = []  # (token_used, text) — куда реально «ушло» сообщение


async def fake_send_ok(token_hint: str, text: str) -> dict:
    SENT.append((token_hint, text))
    return {"ok": True, "detail": "sent"}


# =============================================================================
# 1. Не настроен — выключено, без падения
# =============================================================================
os.environ.pop("TELEGRAM_BOT_TOKEN", None)
os.environ.pop("TELEGRAM_CHAT_ID", None)
check(notification_service.is_configured() is False,
      "Без переменных окружения is_configured() == False")

res = asyncio.run(notification_service.notify_alert_triggered(
    {"id": 999999, "symbol": "TESTPUSH", "condition": "above",
     "target": 1.0, "triggered_price": 2.0}))
check(res.get("ok") is False and res.get("skipped") is True,
      "Без конфигурации уведомление пропускается молча (не исключение)")

# =============================================================================
# 2. Формат текста
# =============================================================================
text = notification_service.format_alert_message({
    "id": 42, "symbol": "MOEX:SBER", "condition": "below",
    "target": 250.0, "triggered_price": 249.3,
    "created_at": "2026-10-24T10:00:00"})
check("MOEX:SBER" in text and "249.3" in text and "ниже 250.0" in text and "№42" in text,
      f"Текст уведомления содержит тикер/цену/условие/id: {text!r}")

# =============================================================================
# 3+4. Срабатывание алерта -> одно уведомление; повтор -> не шлём
# =============================================================================
os.environ["TELEGRAM_BOT_TOKEN"] = "TESTTOKEN"
os.environ["TELEGRAM_CHAT_ID"] = "123456"
check(notification_service.is_configured() is True,
      "С переменными окружения is_configured() == True")

alert = alert_service.create_alert("TESTPUSH", "above", 100.0)

orig_fetch = alert_service._fetch_price
orig_send = notification_service.send_telegram_message

async def fake_price(symbol: str) -> float | None:
    # Мок только для тестовых символов: реальные активные алерты пользователя
    # (если они есть в БД) не должны случайно сработать во время прогона.
    return 150.0 if symbol in ("TESTPUSH", "TESTFAIL") else None

alert_service._fetch_price = fake_price
notification_service.send_telegram_message = lambda t: fake_send_ok("TESTTOKEN", t)
try:
    triggered = asyncio.run(alert_service.check_all_active())
    check(any(t["id"] == alert["id"] for t in triggered),
          "check_all_active вернул сработавший алерт")
    push_msgs = [t for (_, t) in SENT if "TESTPUSH" in t]
    check(len(push_msgs) == 1, f"Отправлено ровно 1 уведомление по TESTPUSH (факт: {len(push_msgs)})")
    check("150" in push_msgs[0], "В тексте есть цена срабатывания")
    with get_session() as db:
        row = db.get(PriceAlert, alert["id"])
        log = (db.query(AlertNotificationLog)
               .filter(AlertNotificationLog.alert_id == alert["id"]).first())
    check(row.status == "triggered", "Статус алерта в БД — 'triggered'")
    check(log is not None, "Факт доставки записан в alert_notification_log")

    # Повторная проверка/повторная отправка не должна спамить дубль
    SENT.clear()
    res2 = asyncio.run(notification_service.notify_alert_triggered(
        {"id": alert["id"], "symbol": "TESTPUSH", "condition": "above",
         "target": 100.0, "triggered_price": 150.0}))
    check(all("TESTPUSH" not in t for (_, t) in SENT) and res2.get("skipped") is True,
          "Для уже доставленного alert_id повторная отправка пропущена (антидубль)")
finally:
    alert_service._fetch_price = orig_fetch
    notification_service.send_telegram_message = orig_send

# =============================================================================
# 5. Сбой Telegram не роняет check_all_active
# =============================================================================
# гарантированно свежий алерт (на случай повторного прогона без очистки БД)
with get_session() as db:
    db.query(PriceAlert).filter(PriceAlert.symbol == "TESTFAIL").delete(synchronize_session=False)
    db.commit()
alert2 = alert_service.create_alert("TESTFAIL", "above", 10.0)

async def fake_send_fail(text: str) -> dict:
    return {"ok": False, "detail": "HTTP 500: telegram down"}

# мок цены активен и здесь (после finally выше _fetch_price был восстановлен)
alert_service._fetch_price = fake_price
notification_service.send_telegram_message = lambda t: fake_send_fail(t)
try:
    asyncio.run(alert_service.check_all_active())
    with get_session() as db:
        row2 = db.get(PriceAlert, alert2["id"])
    check(row2.status == "triggered",
          "Алерт перешёл в 'triggered' даже при недоступном Telegram")
    with get_session() as db:
        row = db.get(PriceAlert, alert2["id"])
        log = (db.query(AlertNotificationLog)
               .filter(AlertNotificationLog.alert_id == alert2["id"]).first())
    check(row.status == "triggered", "Статус 'triggered' сохранён при сбое доставки")
    check(log is None, "При неудачной доставке в лог ничего не записано (можно переотправить)")
finally:
    alert_service._fetch_price = orig_fetch
    notification_service.send_telegram_message = orig_send

# --- Убираем за собой --------------------------------------------------------
with get_session() as db:
    db.query(PriceAlert).filter(PriceAlert.symbol.in_(["TESTPUSH", "TESTFAIL"])).delete(synchronize_session=False)
    db.query(AlertNotificationLog).delete()
    db.commit()

print()
print("RESULT:", "ALL PASSED" if failures == 0 else f"{failures} FAILED")
raise SystemExit(1 if failures else 0)
