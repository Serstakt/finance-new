"""Проверка FUTOI (services/futoi_service.py) на фикстурных данных.

Покрывает чистые функции без обращения к сети:
  * aggregate_daily — сворачивание внутридневных снимков в дневной ряд
    (побеждает последний снимок дня, группы FIZ/YUR, суммы total,
    отсутствующая группа -> None);
  * parse_error_limit — дата из ограничения бесплатного тарифа ISS+;
  * display_name — читаемые подписи популярных инструментов и фолбэки;
  * регрессия пагинации: строки с ERROR_MESSAGE не попадают в ряд.

Запуск: python -m backend.tests_futoi
"""
from backend.services import futoi_service as svc

COLUMNS = [
    "sess_id", "seqnum", "tradedate", "tradetime", "ticker", "clgroup",
    "pos", "pos_long", "pos_short", "pos_long_num", "pos_short_num",
    "systime", "trade_session_date",
]

failures = 0


def check(cond, msg):
    global failures
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def row(trade_date, trade_time, group, pos, long, short, long_num=1,
        short_num=1, ticker="MX"):
    return [
        1, 1, trade_date, trade_time, ticker, group,
        pos, long, short, long_num, short_num,
        f"{trade_date} {trade_time}", trade_date,
    ]


# =============================================================================
# 1. aggregate_daily: последний снимок дня и разрез FIZ/YUR
# =============================================================================
rows = [
    # Порядок как у ISS — от свежих к старым; внутри дня побеждает 23:50.
    row("2026-11-12", "23:50:00", "FIZ", 22836, 122734, -99898, 4994, 3373),
    row("2026-11-12", "23:50:00", "YUR", -22836, 88457, -111293, 133, 74),
    row("2026-11-12", "10:05:00", "FIZ", 999, 99999, -99000, 1, 1),   # старее — должен проиграть
    # 2026-11-11: только физлица, юрлиц нет
    row("2026-11-11", "23:50:00", "FIZ", 13662, 120968, -107306, 4734, 3752),
    # Строка-ошибка ISS не должна попасть в ряд
    ["ERROR_MESSAGE"],
]
columns_error = ["ERROR_MESSAGE"]
daily = svc.aggregate_daily(COLUMNS, rows)

check(len(daily) == 2, "aggregate_daily: две торговые даты")
check([d["date"] for d in daily] == ["2026-11-11", "2026-11-12"],
      "aggregate_daily: порядок по возрастанию даты")

last = daily[1]
check(last["fiz"]["pos_long"] == 122734,
      "aggregate_daily: за день взят последний снимок (122734, не 99999)")
check(last["fiz"]["pos_short"] == -99898, "aggregate_daily: шорты сохраняют знак")
check(last["yur"]["pos_long"] == 88457, "aggregate_daily: группа YUR разобрана")
check(last["total"]["pos_long"] == 122734 + 88457, "aggregate_daily: total.pos_long = FIZ + YUR")
check(last["total"]["pos_short"] == -99898 + -111293, "aggregate_daily: total.pos_short = FIZ + YUR")
check(last["total"]["pos"] == 0, "aggregate_daily: суммарная чистая позиция FIZ+YUR = 0")

first = daily[0]
check(first["yur"] is None, "aggregate_daily: отсутствующая группа -> None")
check(first["total"]["pos_long"] == 120968, "aggregate_daily: total без второй группы")
check(first["systime"] == "2026-11-11 23:50:00", "aggregate_daily: systime последнего снимка")

# Ошибка вместо данных не маскируется под пустой день
check(svc.aggregate_daily(columns_error, [["boom"]]) == [],
      "aggregate_daily: строки ERROR_MESSAGE игнорируются")


# =============================================================================
# 2. parse_error_limit: ограничение бесплатного тарифа
# =============================================================================
msg = ("Invalid date. Free users can't receive data for the last 14 days "
       "(2026-11-12).")
check(svc.parse_error_limit(msg) == "2026-11-12",
      "parse_error_limit: дата из сообщения ISS")
check(svc.parse_error_limit("Invalid date value.") is None,
      "parse_error_limit: сообщение без даты -> None")
check(svc.parse_error_limit("") is None, "parse_error_limit: пустая строка -> None")


# =============================================================================
# 3. display_name: читаемые подписи и фолбэки
# =============================================================================
names = {"MX": "MIX", "AF": "AFLT", "Si": "Si"}
check(svc.display_name("MX", names) == "MIX · Индекс МосБиржи",
      "display_name: популярный инструмент -> русская подпись")
check(svc.display_name("AF", names) == "AFLT · Аэрофлот",
      "display_name: акция -> русская подпись")
check(svc.display_name("Si", names) == "Si · Доллар/рубль",
      "display_name: валюта -> русская подпись")
check(svc.display_name("ZZZ", {"ZZZ": "ZZZ"}) == "ZZZ",
      "display_name: неизвестный код без имени -> сам код")
check(svc.display_name("W4", {"W4": "WHEAT"}) == "WHEAT · W4",
      "display_name: справочник срочного рынка -> «ИМЯ · КОД»")


# =============================================================================
# 4. Регрессия: MAX_DAYS/страховки и допустимый тикер
# =============================================================================
check(svc.MAX_DAYS >= 3000, "MAX_DAYS покрывает всю историю FUTOI (с 2020)")
check(svc.PAGE_SIZE == 1000, "PAGE_SIZE соответствует лимиту ISS")

print()
if failures:
    print(f"❌ Провалено проверок: {failures}")
    raise SystemExit(1)
print("✅ Все проверки FUTOI пройдены")
