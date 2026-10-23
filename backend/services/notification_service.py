"""Push-уведомления о сработавших алертах через Telegram-бота (Bot API).

Зачем: фоновый цикл alert_service проверяет условия даже при закрытом
браузере, но «увидеть» срабатывание без открытой вкладки раньше было
невозможно — статус лежал в БД. Этот сервис добирает недостающее звено:
как только алерт переходит в 'triggered', бот шлёт сообщение в чат.

Конфигурация (переменные окружения / файл .env в корне проекта):
- TELEGRAM_BOT_TOKEN — токен бота от @BotFather;
- TELEGRAM_CHAT_ID  — chat_id получателя (личка или группа).
Как узнать chat_id: отправить боту любое сообщение и открыть
https://api.telegram.org/bot<TOKEN>/getUpdates (или GET /api/notifications/status).

Если переменные не заданы, уведомления просто выключены (is_configured() ==
False) — сервер работает как раньше, ничего не падает.

Отправка идемпотентна: успешная доставка фиксируется в таблице
alert_notification_log (уникальный alert_id), поэтому повторные попытки
(перезапуск сервера, ретраи сети) не заспамят чат одним и тем же алертом.
"""
import asyncio
import logging
import os
from pathlib import Path

import aiohttp
from dotenv import load_dotenv

from backend.database.database import get_session, safe_create_all
from backend.database.models import AlertNotificationLog

logger = logging.getLogger(__name__)

safe_create_all()

# .env ищем рядом с модулем (backend/.env) и в корне проекта (/workspace/.env)
for _candidate in (Path(__file__).resolve().parent.parent / ".env",
                   Path(__file__).resolve().parent.parent.parent / ".env"):
    if _candidate.exists():
        load_dotenv(_candidate)

TELEGRAM_API_BASE = "https://api.telegram.org"
SEND_TIMEOUT_SECONDS = 10
SEND_RETRIES = 2            # всего попыток при сетевых сбоях / 5xx
RETRY_BACKOFF_SECONDS = 1.0


def get_credentials() -> tuple[str | None, str | None]:
    """(token, chat_id) из окружения; любой элемент может быть None."""
    token = (os.getenv("TELEGRAM_BOT_TOKEN") or "").strip()
    chat_id = (os.getenv("TELEGRAM_CHAT_ID") or "").strip()
    return (token or None, chat_id or None)


def is_configured() -> bool:
    token, chat_id = get_credentials()
    return bool(token and chat_id)


def format_alert_message(alert: dict) -> str:
    """Текст push-уведомления о сработавшем алерте."""
    cond_ru = "выше" if alert.get("condition") == "above" else "ниже"
    price = alert.get("triggered_price")
    target = alert.get("target")
    lines = [
        "🚨 Алерт сработал!",
        f"<b>{alert.get('symbol', '?')}</b>: цена {price} достигла цели "
        f"({cond_ru} {target})",
    ]
    created = alert.get("created_at")
    if created:
        lines.append(f"⏰ {created[:19].replace('T', ' ')} UTC — алерт №{alert.get('id')}")
    return "\n".join(lines)


def already_sent(alert_id: int) -> bool:
    """Есть ли уже успешная доставка для этого алерта (защита от дублей)."""
    with get_session() as db:
        return (db.query(AlertNotificationLog)
                .filter(AlertNotificationLog.alert_id == alert_id)
                .first()) is not None


def sent_notifications_count() -> int:
    """Сколько push-уведомлений успешно доставлено всего (для /api/notifications/status)."""
    try:
        with get_session() as db:
            return db.query(AlertNotificationLog).count()
    except Exception:  # noqa: BLE001 — статус должен отвечать даже при проблеме БД
        return 0


def _mark_sent(alert_id: int, chat_id: str) -> None:
    with get_session() as db:
        exists = (db.query(AlertNotificationLog)
                  .filter(AlertNotificationLog.alert_id == alert_id)
                  .first())
        if not exists:
            db.add(AlertNotificationLog(alert_id=alert_id, chat_id=chat_id))
            db.commit()


async def send_telegram_message(text: str) -> dict:
    """Низкоуровневая отправка сообщения ботом (sendMessage) с ретраями.

    Возвращает {"ok": bool, "detail": str}. Ошибки не бросаются — вызывающий
    код (фоновый цикл) не должен падать из-за недоступности Telegram.
    """
    token, chat_id = get_credentials()
    if not token or not chat_id:
        return {"ok": False, "detail": "Telegram не настроен (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)"}

    url = f"{TELEGRAM_API_BASE}/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML",
               "disable_web_page_preview": True}
    last_error = ""
    timeout = aiohttp.ClientTimeout(total=SEND_TIMEOUT_SECONDS)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        for attempt in range(1, SEND_RETRIES + 1):
            try:
                async with session.post(url, json=payload) as resp:
                    body = await resp.text()
                    if resp.status == 200:
                        return {"ok": True, "detail": "sent"}
                    if resp.status >= 500 or resp.status == 429:
                        # временная проблема Telegram — можно повторить
                        last_error = f"HTTP {resp.status}: {body[:200]}"
                    else:
                        # 400/401/403 — конфигурационная ошибка, ретрай бессмысленен
                        return {"ok": False, "detail": f"HTTP {resp.status}: {body[:200]}"}
            except (aiohttp.ClientError, TimeoutError, OSError) as exc:
                last_error = str(exc)
            if attempt < SEND_RETRIES:
                await asyncio.sleep(RETRY_BACKOFF_SECONDS * attempt)
    return {"ok": False, "detail": f"после {SEND_RETRIES} попыток: {last_error}"}


async def notify_alert_triggered(alert: dict) -> dict:
    """Шлёт push-уведомление о сработавшем алерте (идемпотентно по alert_id)."""
    alert_id = alert.get("id")
    if alert_id is None:
        return {"ok": False, "detail": "нет id алерта"}
    if not is_configured():
        return {"ok": False, "skipped": True, "detail": "Telegram не настроен"}
    if already_sent(alert_id):
        return {"ok": True, "skipped": True, "detail": "уже отправлено ранее"}

    result = await send_telegram_message(format_alert_message(alert))
    if result.get("ok"):
        _, chat_id = get_credentials()
        _mark_sent(alert_id, chat_id or "")
        logger.info("Push-уведомление отправлено: алерт %s (%s)",
                    alert.get("symbol"), alert_id)
    else:
        logger.warning("Не удалось отправить push-уведомление по алерту %s: %s",
                       alert_id, result.get("detail"))
    return result


async def notify_alerts_triggered(alerts: list[dict]) -> list[dict]:
    """Массовая рассылка (вызывается из check_all_active после коммита статуса)."""
    results = []
    for a in alerts:
        results.append(await notify_alert_triggered(a))
    return results


async def send_test_message() -> dict:
    """Тестовая отправка для GET/POST /api/notifications/test."""
    if not is_configured():
        return {"ok": False,
                "detail": "Укажите TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в .env или окружении"}
    return await send_telegram_message(
        "✅ Финансовый терминал: тестовое уведомление. "
        "Настройки Telegram-бота работают.")
