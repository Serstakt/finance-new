"""Проверка: раздел перетаскивается вместе со своими тикерами (move_block).

Сценарий пользователя: в watchlist заголовок раздела тянут вниз — тикеры
раздела должны уехать вместе с ним. В плоском порядке раздел — это строка
SECTION:<название> и все тикеры до следующего раздела, поэтому сервер должен
вырезать и вставить их одним куском, а не по одному.
"""
from backend.database.database import get_session, safe_create_all
from backend.database.models import Watchlist, WatchlistItem
from backend.services import watchlist_service as svc

safe_create_all()

LIST_ID = "__test_move_block__"
failures = 0


def check(cond, msg):
    global failures
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def cleanup():
    with get_session() as db:
        db.query(WatchlistItem).filter(WatchlistItem.list_id == LIST_ID).delete()
        db.query(Watchlist).filter(Watchlist.id == LIST_ID).delete()
        db.commit()


def order():
    return [i["symbol"] for i in svc.get_list_symbols(LIST_ID)]


cleanup()

BASE = ["SECTION:Альфа", "A1", "A2", "A3", "SECTION:Бета", "B1", "B2"]
# Альфа — свёрнутая: метаданные не должны потеряться при переезде блока
svc.set_order(LIST_ID, BASE, "Тест", [
    {"symbol": "SECTION:Альфа", "collapsed": True},
])

# --- Раздел уезжает вниз вместе с тикерами ---------------------------------
res = svc.move_block(LIST_ID, ["SECTION:Альфа", "A1", "A2", "A3"], 3)
check(res.get("status") == "ok", "move_block вернул status=ok")
check(order() == ["SECTION:Бета", "B1", "B2", "SECTION:Альфа", "A1", "A2", "A3"],
      "Блок Альфы переехал целиком в конец списка")
check([i["position"] for i in svc.get_list_symbols(LIST_ID)] == list(range(7)),
      "Позиции после переезда плотные 0..6")

# --- Порядок внутри блока берётся из payload -------------------------------
res = svc.move_block(LIST_ID, ["SECTION:Альфа", "A1", "A2", "A3"], 0)
check(res.get("symbols") == ["SECTION:Альфа", "A1", "A2", "A3", "SECTION:Бета", "B1", "B2"],
      "Блок вернулся наверх с сохранением порядка тикеров")

# --- Метаданные строк переезжают вместе со строками ------------------------
check(any(i["symbol"] == "SECTION:Альфа" and i["collapsed"] for i in svc.get_list_symbols(LIST_ID)),
      "Свёрнутость раздела не потерялась при переезде")

# --- Позиция вне диапазона прижимается к краям -----------------------------
svc.move_block(LIST_ID, ["SECTION:Бета", "B1", "B2"], 999)
check(order() == ["SECTION:Альфа", "A1", "A2", "A3", "SECTION:Бета", "B1", "B2"],
      "target_index больше длины прижат к концу (порядок не сломан)")
svc.move_block(LIST_ID, ["SECTION:Бета", "B1", "B2"], -5)
check(order() == ["SECTION:Бета", "B1", "B2", "SECTION:Альфа", "A1", "A2", "A3"],
      "target_index меньше нуля прижат к началу")

# --- Блок с частично отсутствующими символами ------------------------------
res = svc.move_block(LIST_ID, ["SECTION:Альфа", "НЕТ_ТАКОГО", "A2"], 6)
check(res.get("status") == "ok", "Несуществующие символы блока пропускаются")
check(order()[-2:] == ["SECTION:Альфа", "A2"],
      "Найденные строки блока переехали на новую позицию")

# --- Полностью отсутствующий блок ------------------------------------------
res = svc.move_block(LIST_ID, ["НЕТ_ТАКОГО"], 0)
check(res.get("status") == "not_found", "Неизвестный блок → not_found (404 на API)")

# --- Пустой блок -----------------------------------------------------------
try:
    svc.move_block(LIST_ID, [], 0)
    check(False, "Пустой блок должен давать ValueError")
except ValueError:
    check(True, "Пустой блок → ValueError (400 на API)")

cleanup()

print("\nALL TESTS PASSED" if failures == 0 else f"\n{failures} TEST(S) FAILED")
raise SystemExit(0 if failures == 0 else 1)
