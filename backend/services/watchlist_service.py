"""Сервис хранения watchlist в БД (SQLite через SQLAlchemy).

Каждая запись — это строка (list_id, symbol, position, flag_color, collapsed)
в таблице watchlist_items. Символы вида SECTION:... (заголовки разделов) тоже
хранятся как элементы списка, чтобы сохранять порядок и группировку.

flag_color и collapsed раньше жили только в localStorage браузера — теперь они
колонки БД, поэтому избранное (флажки) и свёрнутые разделы не теряются при
смене браузера/устройства.
"""
import html as html_lib
import json
import re
import sqlite3

from backend.database.database import Base, DB_PATH, engine, get_session, safe_create_all
from backend.database.models import Watchlist, WatchlistItem

safe_create_all()

# Допустимые цвета флажков (должны совпадать с FLAG_COLORS на фронтенде).
VALID_FLAG_COLORS = {"red", "blue", "yellow", "orange", "green"}

# Максимальная длина заметки к тикеру (колонка watchlist_items.note).
# Считается по ВИДИМОМУ тексту без HTML-разметки — совпадает с
# window.NOTE_MAX_LEN на фронтенде.
NOTE_MAX_LEN = 500

# Разметка, которую приносит WYSIWYG-редактор заметок (вкладка «Заметки»):
# <br> и закрытие блочных тегов — границы строк, остальные теги — просто стиль.
_NOTE_LINE_BREAK_RE = re.compile(r"<(?:br\s*/?>|/div|/p|/li)[^>]*>", re.IGNORECASE)
_NOTE_TAG_RE = re.compile(r"<[^>]+>")


def _normalize_symbol(symbol: str) -> str:
    """Нормализация тикера: верхний регистр; у SECTION:... сохраняем имя раздела."""
    s = (symbol or "").strip()
    if not s.upper().startswith("SECTION:"):
        return s.upper()
    return "SECTION:" + s[8:]


def migrate_columns() -> None:
    """Добавляет недостающие колонки в существующие таблицы watchlist_items/watchlists.

    create_all не изменяет уже созданные таблицы, а SQLite не поддерживает
    ALTER TABLE ... ADD COLUMN IF NOT EXISTS, поэтому проверяем PRAGMA table_info
    и добавляем недостающие колонки сами. Идемпотентно, вызывается при старте.

    watchlists.active_symbol — выбранный тикер списка; раньше жил только в
    localStorage ('multi_watchlists_state'), теперь источник истины — БД.
    """
    try:
        con = sqlite3.connect(str(DB_PATH))
        try:
            cols = {row[1] for row in con.execute("PRAGMA table_info(watchlist_items)")}
            if "flag_color" not in cols:
                con.execute("ALTER TABLE watchlist_items ADD COLUMN flag_color VARCHAR")
            if "collapsed" not in cols:
                # default=0, чтобы NOT NULL прошёл на существующих строках
                con.execute(
                    "ALTER TABLE watchlist_items ADD COLUMN collapsed BOOLEAN NOT NULL DEFAULT 0"
                )
            if "note" not in cols:
                con.execute("ALTER TABLE watchlist_items ADD COLUMN note TEXT")
            if "markup" not in cols:
                con.execute("ALTER TABLE watchlist_items ADD COLUMN markup TEXT")
            wl_cols = {row[1] for row in con.execute("PRAGMA table_info(watchlists)")}
            if wl_cols and "active_symbol" not in wl_cols:
                con.execute("ALTER TABLE watchlists ADD COLUMN active_symbol VARCHAR")
            con.commit()
        finally:
            con.close()
    except sqlite3.Error:
        # Таблицы ещё нет (создастся create_all со всеми колонками) или база
        # недоступна — не роняем приложение, миграция повторится при следующем старте.
        pass


migrate_columns()


def get_name(list_id: str) -> str | None:
    """Возвращает название списка из таблицы watchlists (или None, если списка нет)."""
    with get_session() as db:
        row = db.get(Watchlist, list_id)
        return row.name if row else None


def get_all_names() -> dict[str, str]:
    """Возвращает все названия списков {id: name} из БД."""
    with get_session() as db:
        rows = db.query(Watchlist).all()
        return {r.id: r.name for r in rows}


def get_active_symbol(list_id: str) -> str | None:
    """Выбранный тикер списка (колонка watchlists.active_symbol) или None."""
    with get_session() as db:
        row = db.get(Watchlist, list_id)
        return row.active_symbol if row else None


def set_active_symbol(list_id: str, symbol: str | None) -> dict:
    """Запоминает выбранный тикер списка в БД (watchlists.active_symbol).

    Символ нормализуется так же, как элементы списка; SECTION:... и пустое
    значение очищают выбор. Список создаётся автоматически, если его ещё нет.
    """
    ensure_list(list_id)
    sym = _normalize_symbol(symbol or "")
    if not sym or sym == "SECTION:" or sym.upper().startswith("SECTION:"):
        sym = None
    with get_session() as db:
        row = db.get(Watchlist, list_id)
        if row is None:
            row = Watchlist(id=list_id, active_symbol=sym)
            db.add(row)
        else:
            row.active_symbol = sym
        db.commit()
        return {"status": "ok", "list_id": list_id, "active_symbol": sym}


# Название-заглушка, которое ставится в watchlists.name, когда список
# автосоздаётся по данным из watchlist_items (без известного имени с UI).
PLACEHOLDER_NAME = "Новый список"


def _is_placeholder(name: str | None, list_id: str) -> bool:
    """Является ли название заглушкой (не настоящим именем с UI)?

    ВАЖНО: к заглушкам НЕ относится дефолтное имя SQLAlchemy-колонки
    («Основной») и любые настоящие пользовательские имена — иначе старый код
    мог перезаписать настоящее имя списков, созданных до появления таблицы.
    """
    if not name:
        return True
    n = name.strip()
    return n == "" or n == PLACEHOLDER_NAME or n == list_id


def ensure_list(list_id: str, default_name: str | None = None) -> None:
    """Гарантирует, что в таблице watchlists есть строка для list_id.

    Используется при добавлении тикеров/порядка: если списка ещё нет в БД
    (например, фронтенд не успел сохранить название), запись создаётся
    автоматически, чтобы watchlist_items и watchlists были согласованы.

    Если default_name передан и непустой — он используется как название новой
    записи; иначе ставится заглушка «Новый список» (никогда не сам list_id).

    ЗАЩИТА ОТ ПЕРЕБИВАНИЯ ИМЕНИ (главный баг «в БД Новый список вместо
    моего имени»): порядок операций такой:
      1) POST /create (set_name) пишет настоящее имя;
      2) затем любой /add или /order вызывает ensure_list.
    Если на шаге 2 строка уже существует с НАСТОЯЩИМ именем — она не
    трогается вообще, даже если default_name пуст или это заглушка.
    Заглушка из прошлых версий («Новый список», list_<timestamp>)
    перезаписывается только настоящим default_name.
    """
    if not list_id or list_id.startswith("fav_"):
        return
    new_name = (default_name or "").strip()
    with get_session() as db:
        row = db.get(Watchlist, list_id)
        if not row:
            db.add(Watchlist(id=list_id, name=new_name or PLACEHOLDER_NAME))
            db.commit()
        elif new_name and not _is_placeholder(new_name, list_id) and _is_placeholder(row.name, list_id):
            # достраиваем настоящее название поверх заглушки, созданной
            # предыдущим запросом (гонка create/add)
            row.name = new_name
            db.commit()


def set_name(list_id: str, name: str) -> dict:
    """Создаёт/обновляет название списка в таблице watchlists.

    Если запись уже существует, но её название — заглушка ("Новый список"),
    созданная ensure_list при добавлении тикера до сохранения названия,
    она перезаписывается настоящим названием с фронтенда.
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("Пустое название списка")
    with get_session() as db:
        row = db.get(Watchlist, list_id)
        if row:
            row.name = name
        else:
            db.add(Watchlist(id=list_id, name=name))
        db.commit()
        return {"status": "ok", "list_id": list_id, "name": name}


def repair_name(list_id: str, name: str) -> bool:
    """Чинит «осиротевшие»/заглушечные записи в таблице watchlists.

    - Если строки для list_id нет — создаёт её с настоящим названием.
    - Если там заглушка ("Новый список" / list_<timestamp> из ensure_list) —
      заменяет её на настоящее название с фронтенда.
    - Если там уже настоящее имя — НЕ трогает (источник истины — переименование).

    Возвращает True, если что-то было исправлено.
    """
    name = (name or "").strip()
    if not name or not list_id or list_id.startswith("fav_"):
        return False
    # само пользовательское имя не должно быть заглушкой
    if _is_placeholder(name, list_id):
        return False
    with get_session() as db:
        row = db.get(Watchlist, list_id)
        if row is None:
            db.add(Watchlist(id=list_id, name=name))
            db.commit()
            return True
        if _is_placeholder(row.name, list_id):
            row.name = name
            db.commit()
            return True
        return False


def repair_names(names: dict[str, str]) -> dict[str, str]:
    """Массовая починка заглушек: {list_id: настоящее_название}.

    Используется эндпоинтом POST /api/watchlist/repair, чтобы залечить
    строки вида «Новый список»/list_<timestamp>, созданные гонкой
    add-before-create. Настоящие имена НЕ перезаписываются.
    Возвращает актуальные названия после починки.
    """
    for list_id, name in (names or {}).items():
        repair_name(str(list_id), str(name))
    return get_all_names()


def delete_list(list_id: str) -> dict:
    """Удаляет список и его элементы из БД."""
    with get_session() as db:
        row = db.get(Watchlist, list_id)
        existed = bool(row)
        if row:
            db.delete(row)
        items = (
            db.query(WatchlistItem)
            .filter(WatchlistItem.list_id == list_id)
            .all()
        )
        for item in items:
            db.delete(item)
        db.commit()
        return {"status": "ok", "list_id": list_id}


def get_list_symbols(list_id: str) -> list[dict]:
    """Возвращает элементы списка в порядке позиции.

    Каждый элемент — dict {symbol, position, flag_color, collapsed, note, markup}.
    """
    with get_session() as db:
            rows = (
                db.query(WatchlistItem)
                .filter(WatchlistItem.list_id == list_id)
                .order_by(WatchlistItem.position.asc(), WatchlistItem.id.asc())
                .all()
            )
            return [
                {
                    "symbol": r.symbol,
                    "position": r.position,
                    "flag_color": r.flag_color,
                    "collapsed": bool(r.collapsed),
                    "note": r.note,
                    "markup": r.markup,
                }
                for r in rows
            ]


def get_all_flags() -> dict[str, str]:
    """Все непустые флажки из БД: {"list_id|SYMBOL": color}.

    Используется фронтендом при загрузке раздела, чтобы восстановить избранное
    на всех устройствах (раньше appState.favorites жил только в localStorage).
    """
    with get_session() as db:
        rows = db.query(WatchlistItem).filter(WatchlistItem.flag_color.isnot(None)).all()
        return {f"{r.list_id}|{r.symbol}": r.flag_color for r in rows if r.flag_color}


def set_flag(list_id: str, symbol: str, color: str | None) -> dict:
    """Ставит/снимает цветной флажок у тикера (избранное) в конкретной строке.

    В отличие от fav_-списков (которые вычисляются из флага на UI), здесь флаг
    хранится именно у элемента конкретного watchlist-списка, поэтому он живёт
    в БД и не теряется при смене браузера.

    color=None/"" снимает флажок. Возвращает 404-сигнал (status=not_found),
    если такого элемента нет.
    """
    symbol = _normalize_symbol(symbol)
    if color is not None:
        color = str(color).strip().lower() or None
        if color and color not in VALID_FLAG_COLORS:
            raise ValueError(f"Недопустимый цвет флажка: {color}")
    with get_session() as db:
        row = (
            db.query(WatchlistItem)
            .filter(WatchlistItem.list_id == list_id, WatchlistItem.symbol == symbol)
            .first()
        )
        if not row:
            return {"status": "not_found", "list_id": list_id, "symbol": symbol}
        row.flag_color = color
        db.commit()
        return {"status": "ok", "list_id": list_id, "symbol": symbol, "flag_color": color}


def set_collapsed(list_id: str, section_symbol: str, collapsed: bool) -> dict:
    """Запоминает состояние свёрнутости раздела (SECTION:...) в БД."""
    symbol = _normalize_symbol(section_symbol)
    if not symbol.upper().startswith("SECTION:"):
        raise ValueError("collapsed можно ставить только разделам SECTION:...")
    with get_session() as db:
        row = (
            db.query(WatchlistItem)
            .filter(WatchlistItem.list_id == list_id, WatchlistItem.symbol == symbol)
            .first()
        )
        if not row:
            return {"status": "not_found", "list_id": list_id, "symbol": symbol}
        row.collapsed = bool(collapsed)
        db.commit()
        return {"status": "ok", "list_id": list_id, "symbol": symbol, "collapsed": bool(collapsed)}


def normalize_note(note: str | None) -> str | None:
    """Приводит заметку к виду для хранения: снимает HTML-разметку, которую
    приносит WYSIWYG-редактор (вкладка «Заметки»), схлопывает пробелы,
    ограничивает длину по видимому тексту.

    NOTE_MAX_LEN считается по символам БЕЗ разметки — фронтенд хранит в БД
    HTML (жирный/курсив/списки), но лимит и поиск должны относиться к тому,
    что пользователь видит. Границы строк (<br>, </div|p|li>) сохраняются
    как переводы строк, остальные теги вырезаются, сущности декодируются.

    Пустая/None возвращает None (заметка снимается).
    """
    if note is None:
        return None
    text = _NOTE_LINE_BREAK_RE.sub("\n", str(note))
    text = _NOTE_TAG_RE.sub("", text)
    text = html_lib.unescape(text)
    cleaned = " ".join(text.split())  # strip + collapse \n, \t, множественные пробелы
    if not cleaned:
        return None
    return cleaned[:NOTE_MAX_LEN]


def set_note(list_id: str, symbol: str, note: str | None) -> dict:
    """Ставит/обновляет/снимает текстовую заметку у элемента списка.

    Заметка хранится в колонке watchlist_items.note (TEXT) — тезис «почему
    слежу за тикером» живёт в БД и не теряется при смене браузера.
    note=None/"" очищает заметку. Возвращает status=not_found, если элемента нет.
    """
    symbol = _normalize_symbol(symbol)
    cleaned = normalize_note(note)
    with get_session() as db:
        row = (
            db.query(WatchlistItem)
            .filter(WatchlistItem.list_id == list_id, WatchlistItem.symbol == symbol)
            .first()
        )
        if not row:
            return {"status": "not_found", "list_id": list_id, "symbol": symbol}
        row.note = cleaned
        db.commit()
        return {"status": "ok", "list_id": list_id, "symbol": symbol, "note": cleaned}


def get_all_notes() -> dict[str, str]:
    """Все непустые заметки из БД: {"list_id|SYMBOL": note}.

    Аналог get_all_flags: фронтенд получает их разом при загрузке раздела,
    чтобы показать иконки 📝 даже в списках, которые ещё не открывались
    (syncListWithDb подтягивает note и для активного списка).
    """
    with get_session() as db:
        rows = db.query(WatchlistItem).filter(WatchlistItem.note.isnot(None)).all()
        return {f"{r.list_id}|{r.symbol}": r.note for r in rows if r.note}


MARKUP_MAX_LEN = 200_000  # ~ограничение размера JSON-массива объектов разметки


def normalize_markup(markup: str | None) -> str | None:
    """Проверяет, что разметка — корректный JSON-массив, и возвращает его
    канонический вид. Пустой массив/None/'' очищает разметку (возвращает None).

    Храним только массивы — чтобы фронтенд (chart_overlay.js) никогда не
    получал битый JSON; всё остальное считаем ошибкой ввода.
    """
    if markup is None:
        return None
    s = str(markup).strip()
    if not s or s == "[]":
        return None
    if len(s) > MARKUP_MAX_LEN:
        raise ValueError("Разметка слишком большая")
    try:
        parsed = json.loads(s)
    except (ValueError, TypeError):
        raise ValueError("Разметка должна быть JSON-массивом")
    if not isinstance(parsed, list):
        raise ValueError("Разметка должна быть JSON-массивом")
    return json.dumps(parsed, ensure_ascii=False)


def set_markup(list_id: str, symbol: str, markup: str | None) -> dict:
    """Сохраняет разметку графика тикера в колонку watchlist_items.markup.

    Разметка (уровни/отметки/текст поверх TradingView-виджета) живёт в БД,
    поэтому переживает смену браузера/устройства так же, как заметки.
    markup=None/""/'[]' очищает разметку. status=not_found — если элемента нет.
    """
    symbol = _normalize_symbol(symbol)
    cleaned = normalize_markup(markup)
    with get_session() as db:
        row = (
            db.query(WatchlistItem)
            .filter(WatchlistItem.list_id == list_id, WatchlistItem.symbol == symbol)
            .first()
        )
        if not row:
            return {"status": "not_found", "list_id": list_id, "symbol": symbol}
        row.markup = cleaned
        db.commit()
        return {"status": "ok", "list_id": list_id, "symbol": symbol}


def add_symbol(list_id: str, symbol: str, list_name: str | None = None) -> dict:
    """Добавляет тикер в конец списка. Повтор не добавляется (идемпотентно).

    Если списка ещё нет в таблице watchlists, он создаётся там автоматически.
    Если передан list_name — новая запись сразу получает настоящее название
    (иначе — заглушку «Новый список», которую перезапишет следующий create).

    Тикеры нормализуются к верхнему регистру (как в moex_service/portfolio_service),
    чтобы "sber" и "SBER" не создавали дубли записей.
    У заголовков разделов SECTION:... нормализуется только префикс — название
    раздела (часть после ':') сохраняется как ввёл пользователь.
    """
    ensure_list(list_id, list_name)
    symbol = symbol.strip()
    if not symbol.upper().startswith("SECTION:"):
        symbol = symbol.upper()
    else:
        symbol = "SECTION:" + symbol[8:]
    if not symbol or symbol == "SECTION:":
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
    """Удаляет тикер из списка и перенумеровывает позиции.

    Нормализация регистра та же, что и в add_symbol. Если удаляемый тикер
    был выбранным (watchlists.active_symbol), выбор сбрасывается — иначе
    в БД осталась бы ссылка на несуществующий символ (данные разошлись бы
    с состоянием UI; ровно такие рассинхроны давал и localStorage).
    """
    symbol = symbol.strip()
    if not symbol.upper().startswith("SECTION:"):
        symbol = symbol.upper()
    else:
        symbol = "SECTION:" + symbol[8:]
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
            wl = db.get(Watchlist, list_id)
            if wl is not None and wl.active_symbol == symbol:
                first_ticker = next(
                    (it.symbol for it in remaining if not it.symbol.startswith("SECTION:")),
                    None,
                )
                wl.active_symbol = first_ticker
            db.commit()
            return {"status": "ok", "list_id": list_id, "symbol": symbol}


def move_symbol(list_id: str, symbol: str, target_index: int) -> dict:
    """Перемещает один элемент списка на новую позицию (drag&drop).

    В отличие от set_order, который перезаписывает весь список снимком с
    клиента, здесь сервер сам читает актуальный порядок из БД и переставляет
    только указанный символ. Это решает две проблемы:
      1) payload не растёт с размером списка;
      2) гонка двух устройств перестаёт терять данные — изменение второго
         устройства (например, добавленный тикер) сохранится, потому что мы
         не затираем список целиком.
    target_index — позиция в списке БЕЗ перемещаемого элемента (0..len-1);
    значения вне диапазона прижимаются к краям. Позиции после перестановки
    перенумеровываются плотно 0..n-1.
    """
    symbol = _normalize_symbol(symbol or "")
    if not symbol:
        raise ValueError("Пустой символ")
    with get_session() as db:
            rows = (
                db.query(WatchlistItem)
                .filter(WatchlistItem.list_id == list_id)
                .order_by(WatchlistItem.position.asc(), WatchlistItem.id.asc())
                .all()
            )
            idx = next((i for i, r in enumerate(rows) if r.symbol == symbol), None)
            if idx is None:
                return {"status": "not_found", "list_id": list_id, "symbol": symbol}

            row = rows.pop(idx)
            try:
                pos = int(target_index)
            except (TypeError, ValueError):
                pos = idx
            pos = max(0, min(pos, len(rows)))
            rows.insert(pos, row)

            # Перенумеровываем только реально сдвинувшиеся строки;
            # flush одним коммитом — список меняется атомарно.
            for i, r in enumerate(rows):
                if r.position != i:
                    r.position = i
            db.commit()
            return {
                "status": "ok",
                "list_id": list_id,
                "symbol": symbol,
                "position": pos,
                "symbols": [r.symbol for r in rows],
            }


def set_order(
    list_id: str,
    symbols: list[str],
    list_name: str | None = None,
    items: list[dict] | None = None,
) -> dict:
    """Заменяет содержимое/порядок списка на переданный (используется для drag&drop).

    Флажки, состояние свёрнутости и заметки существующих элементов сохраняются
    за строками БД (обновляется только position); новые элементы получают
    значения из items (если фронтенд передал flag_color/collapsed/note) либо
    умолчания.
    items: необязательный список {symbol, flag_color?, collapsed?, note?} —
    источник метаданных для новых/пересозданных строк.
    """
    cleaned = []
    for s in symbols:
        if not s or not s.strip():
            continue
        cleaned.append(_normalize_symbol(s))
    # map symbol -> (flag_color, collapsed, note) из расширенного payload
    meta: dict[str, tuple[str | None, bool, str | None]] = {}
    for it in (items or []):
        sym = _normalize_symbol(str(it.get("symbol", "")))
        if not sym:
            continue
        color = it.get("flag_color")
        color = str(color).strip().lower() if color else None
        if color and color not in VALID_FLAG_COLORS:
            color = None
        meta[sym] = (color, bool(it.get("collapsed")), normalize_note(it.get("note")))
    ensure_list(list_id, list_name)
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
                    color, collapsed, note = meta.get(sym, (None, False, None))
                    db.add(WatchlistItem(
                        list_id=list_id, symbol=sym, position=i,
                        flag_color=color, collapsed=collapsed, note=note,
                    ))
            db.commit()
            return {"status": "ok", "list_id": list_id, "count": len(cleaned)}
