"""Подключение к SQLite с защитой от повреждённой базы ('database disk image is malformed').

Повреждение файла БД обычно происходит из-за обрыва записи (Ctrl+C/краш во время
коммита, антивирус, синхронизация облака/Git). Чтобы приложение не падало:

1. При импорте модуля проверяется целостность файла (PRAGMA integrity_check);
   битый файл сохраняется как portfolio.corrupted.<ts>.db.bak и создаётся чистый.
2. create_all() в сервисах вызывается через safe_create_all(): если база оказалась
   битой уже в момент создания таблиц — автоматический бэкап + пересоздание + повтор.
3. Все запросы к БД идут через get_session(): при ошибке 'malformed' во время
   работы приложения база так же автоматически восстанавливается, а операция
   повторяется на чистой БД.
"""
import logging
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from sqlalchemy import create_engine, event
from sqlalchemy.exc import DatabaseError as SQLAlchemyDatabaseError
from sqlalchemy.orm import declarative_base, sessionmaker

logger = logging.getLogger(__name__)

DB_PATH = Path(__file__).parent / "portfolio.db"


def _is_db_healthy(path: Path) -> bool:
    """Проверяет целостность файла SQLite через PRAGMA integrity_check."""
    if not path.exists():
        return True  # файла нет — создавать нечего, всё в порядке
    try:
        con = sqlite3.connect(str(path))
        try:
            result = con.execute("PRAGMA integrity_check").fetchone()
            return result is not None and result[0] == "ok"
        finally:
            con.close()
    except sqlite3.DatabaseError:
        return False


# --- Ранняя проверка при импорте ---------------------------------------------------
# Если файл повреждён — чиним его ДО создания engine/сессий. Повторяем проверку
# несколько раз: файл мог быть перезаписан другим процессом (--reload-воркером)
# сразу после проверки.
for _attempt in range(3):
    if _is_db_healthy(DB_PATH):
        break
    _backup_path = DB_PATH.with_name(f"portfolio.corrupted.{int(time.time())}.db.bak")
    logger.warning(
        "База данных %s повреждена (проверка при старте, попытка %d). "
        "Сохраняем копию как %s и создаём новую чистую БД.",
        DB_PATH, _attempt + 1, _backup_path,
    )
    for _suffix in ("-wal", "-shm"):
        try:
            _p = Path(str(DB_PATH) + _suffix)
            if _p.exists():
                _p.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        DB_PATH.replace(_backup_path)
    except OSError as _exc:
        logger.error("Не удалось переименовать повреждённую БД: %s. Удаляем файл.", _exc)
        try:
            DB_PATH.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        DB_PATH.touch()
    except OSError as _exc:
        logger.error("Не удалось создать файл БД %s: %s", DB_PATH, _exc)


engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)


@event.listens_for(engine, "connect")
def _set_sqlite_pragmas(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    try:
        # DELETE вместо WAL: не создаёт sidecar-файлы portfolio.db-wal/-shm,
        # которые мешают работе с Git (постоянно "изменённые файлы").
        cursor.execute("PRAGMA journal_mode=DELETE")
    except sqlite3.Error as exc:
        # Не роняем приложение из-за pragma (read-only ФС, сетевой диск и т.п.)
        logger.warning("Не удалось включить WAL-режим для %s: %s", DB_PATH, exc)
    finally:
        try:
            cursor.close()
        except Exception:  # noqa: BLE001
            pass


SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def _backup_and_recreate_corrupted_db(reason: str) -> None:
    """Сохраняет копию повреждённого файла БД и создаёт чистую базу.

    Пул соединений SQLAlchemy может держать битый файл открытым (особенно на
    Windows), поэтому сначала освобождаем пул (engine.dispose), затем удаляем
    sidecar-файлы WAL и пересоздаём сам файл.
    """
    backup_path = DB_PATH.with_name(f"portfolio.corrupted.{int(time.time())}.db.bak")
    logger.warning(
        "База данных %s повреждена (%s). Сохраняем копию как %s и создаём новую чистую БД.",
        DB_PATH, reason, backup_path,
    )
    try:
        engine.dispose()
    except Exception:  # noqa: BLE001 — dispose не должен блокировать восстановление
        pass
    for suffix in ("-wal", "-shm"):
        try:
            p = Path(str(DB_PATH) + suffix)
            if p.exists():
                p.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        DB_PATH.replace(backup_path)
    except OSError as exc:
        logger.error("Не удалось переименовать повреждённую БД: %s. Удаляем файл.", exc)
        try:
            DB_PATH.unlink(missing_ok=True)
        except OSError:
            pass
    try:
        DB_PATH.touch()
    except OSError as exc:
        logger.error("Не удалось создать файл БД %s: %s", DB_PATH, exc)


def safe_create_all() -> None:
    """Base.metadata.create_all с авто-восстановлением при повреждении БД.

    Используется в сервисах вместо прямого Base.metadata.create_all(bind=engine):
    если в этот момент файл БД оказывается битым (например его успел перезаписать
    другой процесс), делаем бэкап, пересоздаём чистую базу и повторяем.
    """
    for attempt in range(2):
        try:
            Base.metadata.create_all(bind=engine)
            return
        except SQLAlchemyDatabaseError as exc:
            if "malformed" not in str(exc).lower():
                raise
            logger.warning("Malformed DB при create_all (попытка %d): %s", attempt + 1, exc)
            _backup_and_recreate_corrupted_db("ошибка при создании таблиц")
    # последняя попытка — без проглатывания ошибки
    Base.metadata.create_all(bind=engine)


@contextmanager
def get_session():
    """Сессия БД с авто-восстановлением при 'database disk image is malformed'.

    Использование: with get_session() as db: ...
    Если во время запроса выяснится, что файл БД повреждён, база автоматически
    бэкапится и пересоздаётся (вместе с таблицами), а операция повторяется
    на чистой БД — вместо 500-й ошибки у пользователя.
    """
    db = SessionLocal()
    recovered = False
    try:
        yield db
        return
    except SQLAlchemyDatabaseError as exc:
        if "malformed" not in str(exc).lower():
            raise
        logger.warning("Malformed DB во время запроса, восстанавливаем базу: %s", exc)
        recovered = True
    finally:
        db.close()

    if recovered:
        _backup_and_recreate_corrupted_db("ошибка обнаружена во время работы приложения")
        Base.metadata.create_all(bind=engine)
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()


def get_db():
    """FastAPI dependency (совместимость со старым кодом)."""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
