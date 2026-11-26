"""Отчётность — бухгалтерская (финансовая) отчётность из PDF/ZIP.

Раздел справа от FUTOI: пользователь сам загружает PDF (или ZIP с PDF),
сервис находит в нём таблицы отчётности и сохраняет результат в SQLite,
фронтенд (js/reports.js) рисует вкладки и таблицы.

Парсер не привязан к конкретному эмитенту. Конфиг таблиц (_TABLE_DEFS)
ищет в тексте страницы заголовки «Отчет о прибылях и убытках», «… о
совокупном доходе», «… о движении денежных средств», «… об изменениях
в капитале» и «Бухгалтерский баланс», а колонки определяет геометрически:
в финансовых таблицах числа выровнены по правому краю, поэтому правые
края чисел образуют устойчивые кластеры-колонки. Так распознаются
2- и 3-колоночные таблицы, переносы строк в названиях статей, отступы
(иерархия статей), жирные итоги и отрицательные значения в скобках.

Страницы-сканы без текстового слоя (обычно баланс) честно помечаются
в notes — для них нужен OCR, выдумывать данные нельзя.

Хранение: сам PDF после разбора не нужен и не сохраняется (файлы бывают
по несколько мегабайт); в БД лежит JSON уже распознанных таблиц.
"""
from __future__ import annotations

import io
import json
import logging
import re
import subprocess
import sys
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from statistics import median
from typing import Optional

try:  # PyMuPDF 1.24+; в старых сборках модуль назывался fitz
    import pymupdf as fitz
except ImportError:  # pragma: no cover — совместимость со старыми сборками
    try:
        import fitz
    except ImportError:  # пакет не установлен — приложение продолжает работать
        fitz = None  # разбор PDF вернёт понятную ошибку при загрузке файла

from backend.database.database import engine, get_session, safe_create_all
from backend.database.models import ReportDocument
from backend.services import report_metrics_service

safe_create_all()


def _ensure_schema() -> None:
    """Добавляет колонки, появившиеся после первых версий раздела.

    create_all() не меняет уже существующую таблицу, поэтому для баз,
    созданных до привязки отчётов к бумаге, нужен лёгкий ALTER TABLE.
    """
    with engine.begin() as connection:
        rows = connection.exec_driver_sql(
            "PRAGMA table_info(report_documents)"
        ).fetchall()
        columns = {row[1] for row in rows}
        if "ticker" not in columns:
            connection.exec_driver_sql(
                "ALTER TABLE report_documents ADD COLUMN ticker VARCHAR"
            )
        if "columns_json" not in columns:
            connection.exec_driver_sql(
                "ALTER TABLE report_documents ADD COLUMN columns_json "
                "TEXT NOT NULL DEFAULT '[]'"
            )
        connection.exec_driver_sql(
            "CREATE INDEX IF NOT EXISTS ix_report_documents_ticker "
            "ON report_documents (ticker)"
        )


_ensure_schema()

logger = logging.getLogger(__name__)

# Ограничения загрузки (защита от «тяжёлых» файлов и zip-бомб).
MAX_UPLOAD_BYTES = 30 * 1024 * 1024
MAX_ARCHIVE_BYTES = 120 * 1024 * 1024
MAX_PDFS_PER_ARCHIVE = 8

# Таблицы, которые ищем в документе. pattern — регулярка по тексту страницы
# (регистр не важен); label — короткое имя для вкладки в интерфейсе.
_TABLE_DEFS = (
    {
        "key": "income",
        "label": "Отчет о прибылях и убытках",
        "pattern": r"отч[её]т\s+о\s+прибылях\s+и\s+убытках",
    },
    {
        "key": "comprehensive",
        "label": "Отчет о совокупном доходе",
        "pattern": r"отч[её]т\s+о\s+совокупном\s+доходе",
    },
    {
        "key": "cashflow",
        "label": "Отчет о движении денежных средств",
        "pattern": r"отч[её]т\s+о\s+движении\s+денежных\s+средств",
    },
    {
        "key": "equity",
        "label": "Отчет об изменениях в капитале",
        "pattern": r"отч[её]т\s+об?\s+изменениях\s+в\s+капитале",
    },
    {
        "key": "balance",
        "label": "Бухгалтерский баланс",
        "pattern": r"бухгалтерск\w*\s+баланс|отч[её]т\s+о\s+финансовом\s+положении",
    },
)

# Подписи шапки: «За 6 мес. 2026», «на 31 декабря 2025», «Показатель»,
# «тыс. руб.» и т.п. Нужны, чтобы отличить шапку от строки-раздела,
# которая тоже может стоять над первыми данными. Проверяется только
# текстовая часть строки (без чисел): иначе статья «Остаток на 1 января
# 2026» принималась бы за шапку из-за года в названии.
_HEADER_LABEL_RE = re.compile(
    r"^\s*(?:за|на)\s|^\s*прим\.?\s|показател|стать|примечан|тыс\.|млн|руб",
    re.IGNORECASE,
)
_UNITS_RE = re.compile(
    r"\(?\s*в\s+(?:миллионах|миллиардах|тысячах|млн|млрд|тыс\.)",
    re.IGNORECASE,
)
_NUMERIC_RE = re.compile(r"^[([]?[-−–]?\d[\d\s\u00a0'’.,]*[)\]]?$")
_DIGIT_RE = re.compile(r"\d")
_YEAR_RE = re.compile(r"^(?:19|20)\d{2}$")
_FOOTER_RE = re.compile(r"^(?:\d{1,3}|стр\.\s*\d+|page\s*\d+)$", re.IGNORECASE)
# Подписи и примечание под таблицей: после них данных уже нет, а номер
# страницы внизу может случайно попасть в последнюю колонку.
_TABLE_END_RE = re.compile(
    r"^(?:данн|настоящ|временно\s+исполняющ|заместитель\s+генеральн"
    r"|генеральный\s+директор|главный\s+бухгалтер|председатель\s+правления"
    r"|управляющий\s+директор)\w*",
    re.IGNORECASE,
)
_DOT_LEADER_RE = re.compile(r"[\s.]{4,}\d{1,3}\s*$")
# Жирные подписи-«зонтики» над колонками (даты блоков, группы капитала):
# в отличие от строки-раздела их нельзя считать первой статьёй таблицы.
_GROUP_HEADER_RE = re.compile(
    r"январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр"
    r"|капитал|акционер|доля неконтрол",
    re.IGNORECASE,
)


@dataclass
class Token:
    """Кусок текста строки с координатами: колонки в PDF — это геометрия."""

    text: str
    x0: float
    x1: float
    y0: float
    y1: float
    size: float
    bold: bool


@dataclass
class Line:
    """Строка PDF: токены, выровненные по одной базовой линии."""

    tokens: list[Token]
    y: float
    page_width: float

    @property
    def text(self) -> str:
        return " ".join(t.text for t in self.tokens if t.text.strip())

    @property
    def label_x(self) -> float:
        return min((t.x0 for t in self.tokens), default=0.0)

    @property
    def bold(self) -> bool:
        labels = [t for t in self.tokens if not _is_number(t.text)]
        if not labels:
            return False
        return sum(1 for t in labels if t.bold) >= max(1, len(labels) // 2)


@dataclass
class Column:
    """Числовая колонка: правый край чисел и границы для отнесения."""

    right: float
    left: float
    right_bound: float


def _clean(text: str) -> str:
    """Нормализует пробелы (в т.ч. неразрывные) внутри токена."""
    return re.sub(r"\s+", " ", text.replace("\u00a0", " ")).strip()


def _is_number(text: str) -> bool:
    raw = _clean(text)
    return bool(raw) and bool(_DIGIT_RE.search(raw)) and bool(_NUMERIC_RE.match(raw))


def _is_year(text: str) -> bool:
    return bool(_YEAR_RE.match(_clean(text)))


def _span_bold(span: dict) -> bool:
    """Жирность: флаг 16 в PyMuPDF или имя шрифта с Bold/Black/Heavy."""
    if int(span.get("flags") or 0) & 16:
        return True
    font = (span.get("font") or "").lower()
    return any(word in font for word in ("bold", "black", "heavy", "semibold"))


def _page_lines(page) -> list[Line]:
    """Собирает строки страницы: символы склеиваются в токены по разрывам.

    Разрыв больше ~0.9em означает новую ячейку таблицы, обычный пробел —
    часть названия статьи («816 587» с пробелом-разделителем остаётся
    одним числом).

    Важно: сырые «строки» PyMuPDF — это структура блоков PDF, а не
    визуальные строки. В отчётностях название статьи и её числа часто
    лежат в разных блоках на одной высоте, поэтому токены со всех блоков
    дополнительно группируются по Y (одна базовая линия = одна строка).
    """
    raw = page.get_text("rawdict")
    tokens: list[Token] = []
    for block in raw.get("blocks", []):
        if block.get("type") != 0:  # только текст, картинки пропускаем
            continue
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                size = float(span.get("size") or 10.0)
                bold = _span_bold(span)
                current: Optional[dict] = None
                pending_space = False

                for char in span.get("chars", []):
                    symbol = char.get("c", "")
                    bbox = char.get("bbox") or (0.0, 0.0, 0.0, 0.0)
                    if not symbol.strip():
                        if current is not None:
                            pending_space = True
                        continue

                    gap = bbox[0] - current["x1"] if current else None
                    if current is None or gap > size * 0.9:
                        if current:
                            tokens.append(Token(**_finish(current)))
                        current = {
                            "text": symbol, "x0": bbox[0], "x1": bbox[2],
                            "y0": bbox[1], "y1": bbox[3], "size": size, "bold": bold,
                        }
                    else:
                        if pending_space:
                            current["text"] += " "
                        current["text"] += symbol
                        current["x0"] = min(current["x0"], bbox[0])
                        current["x1"] = max(current["x1"], bbox[2])
                        current["y0"] = min(current["y0"], bbox[1])
                        current["y1"] = max(current["y1"], bbox[3])
                    pending_space = False

                if current:
                    tokens.append(Token(**_finish(current)))

    tokens = [t for t in tokens if t.text]
    if not tokens:
        return []
    tokens.sort(key=lambda t: ((t.y0 + t.y1) / 2, t.x0))

    lines: list[Line] = []
    for token in tokens:
        center = (token.y0 + token.y1) / 2
        tolerance = max(2.5, token.size * 0.45)
        if lines and abs(center - lines[-1].y) <= tolerance:
            line = lines[-1]
            line.tokens.append(token)
            line.y = (line.y * (len(line.tokens) - 1) + center) / len(line.tokens)
        else:
            lines.append(Line(tokens=[token], y=center, page_width=page.rect.width))

    for line in lines:
        line.tokens.sort(key=lambda t: t.x0)
    lines.sort(key=lambda ln: ln.y)
    return lines


def _finish(token: dict) -> dict:
    token["text"] = _clean(token["text"])
    return token


def _page_text(lines: list[Line]) -> tuple[str, list[tuple[int, int, int]]]:
    """Текст страницы одной строкой + карта (начало, конец, номер строки)."""
    parts: list[str] = []
    spans: list[tuple[int, int, int]] = []
    pos = 0
    for idx, line in enumerate(lines):
        text = line.text
        if not text:
            continue
        spans.append((pos, pos + len(text), idx))
        parts.append(text)
        pos += len(text) + 1
    return " ".join(parts), spans


def _line_at(spans: list[tuple[int, int, int]], offset: int) -> Optional[int]:
    for start, end, idx in spans:
        if start <= offset <= end:
            return idx
    return None


def _is_footer(text: str) -> bool:
    return bool(_FOOTER_RE.match(text.strip()))


def _is_toc_page(text: str) -> bool:
    low = text.lower()
    return "содержание" in low or "оглавление" in low or "table of contents" in low


def _find_heading(lines: list[Line], pattern: re.Pattern) -> Optional[int]:
    """Индекс строки, в которой заканчивается заголовок таблицы.

    Заголовки в отчётности переносятся на 2–3 строки, поэтому ищем по
    склеенному тексту страницы. Страницы оглавления пропускаем — там
    названия всех таблиц встречаются до самих таблиц. Из нескольких
    совпадений берём то, под которым больше чисел (настоящая таблица,
    а не упоминание в сноске).
    """
    text, spans = _page_text(lines)
    if not text or _is_toc_page(text):
        return None
    # Оглавление без слова «Содержание»: несколько строк с точками-выносками.
    if sum(1 for line in lines if _DOT_LEADER_RE.search(line.text)) >= 3:
        return None

    best: Optional[tuple[int, int]] = None  # (score, line_idx)
    low = text.lower()
    for match in pattern.finditer(low):
        idx = _line_at(spans, match.end() - 1)
        if idx is None:
            continue
        line = lines[idx]
        if len(line.text) > 200:
            continue
        if _DOT_LEADER_RE.search(line.text):
            continue
        # Упоминание внутри абзаца не считаем заголовком: фраза должна
        # начинаться недалеко от начала строки.
        span_start = next((s for s, _e, i in spans if i == idx), match.start())
        if match.start() - span_start > 100:
            continue
        numbers = sum(
            1 for ln in lines[idx + 1:] for t in ln.tokens if _is_number(t.text)
        )
        if numbers < 4:
            continue
        if best is None or numbers > best[0]:
            best = (numbers, idx)
    return best[1] if best else None


def _cluster(values: list[float], tolerance: float) -> list[list[float]]:
    if not values:
        return []
    ordered = sorted(values)
    groups: list[list[float]] = [[ordered[0]]]
    for value in ordered[1:]:
        if value - groups[-1][-1] <= tolerance:
            groups[-1].append(value)
        else:
            groups.append([value])
    return groups


def _build_columns(lines: list[Line], page_width: float) -> list[Column]:
    """Колонки по правым краям чисел: числа в финтаблицах выровнены вправо."""
    numbers = [
        (t.x1, t.x0, t.size, t.text)
        for line in lines
        for t in line.tokens
        if _is_number(t.text)
    ]
    if not numbers:
        return []

    base_size = median([size for _, _, size, _ in numbers]) or 10.0
    groups = _cluster(
        [x1 for x1, _, _, _ in numbers],
        tolerance=max(5.0, base_size * 0.9),
    )

    # Слишком близкие кластеры — одна колонка (разные варианты выравнивания).
    # Вместе с координатами храним тексты: по ним отсеиваются «колонки»
    # из дат в названиях статей («Сальдо на 31 декабря 2024 г.») и номеров
    # примечаний — они тоже выровнены вправо, но данными не являются.
    merged: list[list[float]] = []
    for group in groups:
        if merged and median(group) - median(merged[-1]) < max(18.0, base_size * 2.2):
            merged[-1].extend(group)
        else:
            merged.append(list(group))

    def group_texts(group: list[float]) -> list[str]:
        texts = []
        for x1, _x0, _size, text in numbers:
            if any(abs(x1 - center) <= 0.01 for center in group):
                texts.append(_clean(text))
        return texts

    def is_data_group(texts: list[str]) -> bool:
        if not texts:
            return False
        noise = 0
        for text in texts:
            if _is_year(text) or re.fullmatch(r"\d{1,2}", text):
                noise += 1
        return noise < max(1, len(texts)) * 0.7

    data_groups = [group for group in merged if is_data_group(group_texts(group))]
    finals = sorted(median(group) for group in (data_groups or merged))
    if not finals:
        return []

    # Левый край первой колонки — по числам, которые к ней действительно
    # относятся (иначе годы/номера страниц сместили бы границу названий).
    limit = max(10.0, base_size * 1.4)
    first_column_lefts = [
        x0 for x1, x0, _size, _text in numbers if abs(x1 - finals[0]) <= limit
    ]
    first_left = min(first_column_lefts) if first_column_lefts else finals[0] - 60

    columns: list[Column] = []
    for i, right in enumerate(finals):
        left = first_left - 8 if i == 0 else (finals[i - 1] + right) / 2
        right_bound = page_width if i == len(finals) - 1 else (right + finals[i + 1]) / 2
        columns.append(Column(right=right, left=left, right_bound=right_bound))
    return columns

    columns: list[Column] = []
    for i, right in enumerate(finals):
        left = first_left - 8 if i == 0 else (finals[i - 1] + right) / 2
        right_bound = page_width if i == len(finals) - 1 else (right + finals[i + 1]) / 2
        columns.append(Column(right=right, left=left, right_bound=right_bound))
    return columns


def _column_index(columns: list[Column], token: Token) -> Optional[int]:
    """Колонка для числа — по правому краю (у чисел он выровнен)."""
    best: Optional[int] = None
    best_dist = float("inf")
    for idx, column in enumerate(columns):
        dist = abs(token.x1 - column.right)
        if dist < best_dist:
            best, best_dist = idx, dist
    if best is not None and best_dist <= max(12.0, token.size * 1.4):
        return best
    # Фолбэк — по центру токена внутри границ колонки (числа с «руб.» и т.п.).
    center = (token.x0 + token.x1) / 2
    for idx, column in enumerate(columns):
        if column.left <= center <= column.right_bound:
            return idx
    return None


def _label_of(line: Line, columns: list[Column]) -> str:
    """Название статьи — текст левее первой числовой колонки.

    Числа внутри названия («Сальдо на 31 декабря 2024 г.») сохраняем:
    они стоят вплотную к словам. Одиночные числа далеко справа (номера
    примечаний) в название не попадают.
    """
    limit = columns[0].left + 2
    parts: list[str] = []
    for index, token in enumerate(line.tokens):
        if token.x1 > limit:
            continue
        if not _is_number(token.text):
            parts.append(token.text)
            continue
        neighbours = line.tokens[max(0, index - 1):index] + line.tokens[index + 1:index + 2]
        adjacent = any(
            not _is_number(other.text)
            and min(abs(other.x0 - token.x1), abs(token.x0 - other.x1))
            <= max(4.0, token.size * 2.0)
            for other in neighbours
        )
        if adjacent:
            parts.append(token.text)
    return " ".join(parts).strip()


def _header_column(columns: list[Column], token: Token) -> Optional[int]:
    """Колонка для подписи шапки: подписи бывают по центру, а не вправо.

    Допуск шире, чем у чисел: расстояние между колонками делится пополам,
    поэтому подпись «Нераспределенная прибыль» попадает в свою колонку,
    даже если её правый край не совпадает с правым краем чисел.
    """
    gaps = [columns[i + 1].right - columns[i].right for i in range(len(columns) - 1)]
    tolerance = (min(gaps) / 2 + 12) if gaps else 60.0

    best = min(range(len(columns)), key=lambda i: abs(token.x1 - columns[i].right))
    if abs(token.x1 - columns[best].right) <= tolerance:
        return best

    center = (token.x0 + token.x1) / 2
    for i, column in enumerate(columns):
        if column.left <= center <= column.right_bound:
            return i
    return None


def _is_headerish(line: Line) -> bool:
    """Похожа ли строка на шапку таблицы (а не на статью или раздел).

    Шапка — это подписи периодов («За 6 мес. 2026», «на 31 декабря 2025»),
    заголовок столбца названий («Показатель»), строка единиц измерения
    («(в миллионах рублей)») или строка только из годов («2026 2025»).
    """
    text = line.text.strip()
    if not text:
        return True
    if _UNITS_RE.search(text):
        return True

    numeric = [t for t in line.tokens if _is_number(t.text)]
    if numeric and len(numeric) == len(line.tokens):
        # Только числа: годы шапки («2026 2025») или короткие подписи.
        return all(_is_year(t.text) or len(_clean(t.text)) <= 2 for t in numeric)

    label = " ".join(t.text for t in line.tokens if not _is_number(t.text))
    return bool(_HEADER_LABEL_RE.search(label))


def _data_start(
    lines: list[Line],
    columns: list[Column],
    min_index: int = 0,
) -> Optional[int]:
    """Первая строка с данными: есть название статьи и хотя бы одно число.

    min_index — не искать выше строки единиц измерения: над ней стоит
    подзаголовок документа («за шесть месяцев, закончившихся 30 июня
    2025 г. (не прошедший аудит)»), который похож на данные из-за года.
    """
    for idx in range(min_index, len(lines)):
        line = lines[idx]
        if _is_headerish(line):
            continue
        label = _label_of(line, columns)
        if not label:
            continue
        if any(
            _column_index(columns, t) is not None
            for t in line.tokens if _is_number(t.text)
        ):
            return idx
    return None


def _header_names(
    header_lines: list[Line],
    columns: list[Column],
    fallback_years: dict[int, str],
    ocr: bool = False,
) -> tuple[str, list[str]]:
    """Названия колонок из шапки таблицы.

    Шапка в отчётности многоуровневая: над колонками стоят общие подписи
    («За шесть месяцев, закончившихся», «30 июня»), а на нижнем уровне —
    годы или названия колонок капитала. Поэтому:
      * общий текст, растянутый над несколькими колонками, становится
        префиксом названий всех колонок;
      * остальные подписи накапливаются по своим колонкам сверху вниз —
        так «Капитал, относящийся» + «к акционерам» + «ПАО «НОВАТЭК»»
        складываются в целое название.
    """
    left_parts: list[str] = []
    shared: list[str] = []
    per_column: list[list[str]] = [[] for _ in columns]
    table_left = columns[0].left
    table_width = max(1.0, columns[-1].right - columns[0].left)

    def add_group(group: dict) -> None:
        """Отнести подпись-группу к колонке, префиксу или левой колонке."""
        text = group["text"].rstrip(':').strip()
        if not text:
            return
        if (group["x1"] - group["x0"]) > table_width * 0.75:
            if text not in shared:
                shared.append(text)
            return
        # Подписи периодов прижаты к своей колонке — смотрим на правый
        # край с широким допуском, как у чисел.
        token = Token(
            text=text, x0=group["x0"], x1=group["x1"],
            y0=group["y0"], y1=group["y1"], size=group["size"], bold=False,
        )
        index = _header_column(columns, token)
        if index is None:
            if group["x1"] <= table_left:
                left_parts.append(text)
            return
        if text not in per_column[index]:
            per_column[index].append(text)

    for line in header_lines:
        if _UNITS_RE.search(line.text):
            continue
        if all(_is_number(t.text) for t in line.tokens):
            continue

        # OCR отдаёт подпись по словам («30», «июня», «2026», «г.»). Склеиваем
        # слова подписи в группу по небольшим пробелам — иначе «30» уезжает
        # в соседнюю колонку примечаний, а «31» — в предыдущую. В текстовом
        # слое склеивать нельзя: там пробел между словами разделяет колонки.
        groups: list[dict] = []
        for token in line.tokens:
            if groups and ocr:
                previous = groups[-1]
                gap = token.x0 - previous["x1"]
                if gap <= max(2.0, token.size * 1.2):
                    previous["text"] += " " + token.text
                    previous["x1"] = max(previous["x1"], token.x1)
                    previous["y0"] = min(previous["y0"], token.y0)
                    previous["y1"] = max(previous["y1"], token.y1)
                    continue
            groups.append({
                "text": token.text,
                "x0": token.x0, "x1": token.x1,
                "y0": token.y0, "y1": token.y1,
                "size": token.size,
            })
        for group in groups:
            add_group(group)

    prefix = " ".join(shared).strip()
    names: list[str] = []
    for i, parts in enumerate(per_column):
        name = re.sub(r"\s+", " ", " ".join(parts)).strip()
        if prefix and prefix not in name:
            name = f"{prefix} {name}".strip()
        if not name:
            name = fallback_years.get(i, f"Значение {i + 1}")
        elif not re.search(r"\b(?:19|20)\d{2}\b", name) and fallback_years.get(i):
            # Год добавляем, если его ещё нет (цифры «30 июня» — не год).
            name = f"{name} {fallback_years[i]}".strip()
        names.append(re.sub(r":\s*$", "", name).strip())

    left_name = " ".join(left_parts).strip()
    # В левой колонке ожидается «Показатель»/«Статья»; длинная фраза здесь —
    # это общая подпись блока, а не заголовок столбца названий.
    if not re.match(r"^(показател|стать|наименован)", left_name, re.IGNORECASE):
        left_name = "Показатель"
    return left_name, names


def _next_content(lines: list[Line], start: int) -> Optional[Line]:
    for line in lines[start:]:
        if line.text.strip():
            return line
    return None


def _set_indents(rows: list[dict]) -> None:
    """Проставляет уровень отступа статьи (иерархия «Итого → подстатьи»)."""
    if not rows:
        return
    base = min(row["_x"] for row in rows)
    offsets = sorted({round(row["_x"] - base, 1) for row in rows if row["_x"] - base > 2.0})
    step = min(offsets) if offsets else 12.0
    for row in rows:
        level = 0 if row.get("section") else int(round((row["_x"] - base) / max(step, 1.0)))
        row["indent"] = max(0, min(level, 5))
        row.pop("_x", None)


def _parse_rows(row_lines: list[Line], columns: list[Column]) -> list[dict]:
    """Строки таблицы по готовой геометрии колонок (данные, разделы, переносы)."""
    rows: list[dict] = []
    pending_label: Optional[str] = None
    pending_x: Optional[float] = None
    pending_section = ""

    for offset, line in enumerate(row_lines):
        label = _label_of(line, columns)

        cells: list[Optional[str]] = [None] * len(columns)
        for token in (t for t in line.tokens if _is_number(t.text)):
            index = _column_index(columns, token)
            if index is None:
                continue
            cells[index] = (cells[index] + " " + token.text) if cells[index] else token.text

        has_cells = any(cells)
        if not label and not has_cells:
            continue

        # OCR иногда выносит «г.» из даты в названии на отдельную строку.
        if (
            not has_cells
            and rows
            and not rows[-1]["section"]
            and re.fullmatch(r"[гГ]\.?,?", label)
        ):
            rows[-1]["label"] = f"{rows[-1]['label']} {label}".strip()
            continue

        # Номер страницы внизу («9», «стр. 6») — таблица закончилась. Раньше
        # такая строка попадала в данные отдельной строкой «—».
        if not label and line.text.strip().isdigit():
            break
        if not has_cells and _is_footer(line.text):
            break
        if _TABLE_END_RE.search(label) or _TABLE_END_RE.search(line.text.strip()):
            break

        if not has_cells:
            # Строка без чисел — либо раздел, либо перенос названия статьи
            # на следующую строку. Перенос: следующая строка с данными
            # начинается со строчной буквы (или с того же отступа).
            next_line = _next_content(row_lines, offset + 1)
            next_numbers = False
            next_label = ""
            if next_line is not None:
                next_label = _label_of(next_line, columns)
                next_numbers = any(
                    _column_index(columns, t) is not None
                    for t in next_line.tokens if _is_number(t.text)
                )
            if next_numbers and next_label and next_label[0].islower():
                pending_label = f"{pending_section} {label}".strip()
                pending_x = line.label_x
                pending_section = ""
                continue
            # Многострочный заголовок раздела («За шесть месяцев,
            # закончившихся» + «30 июня 2025 г.») склеиваем в одну строку,
            # но только если вторая строка не начинает новую статью.
            if (
                next_line is not None
                and not next_numbers
                and (not next_label or not next_label[0].isupper())
            ):
                pending_section = f"{pending_section} {label}".strip()
                continue
            rows.append({
                "label": f"{pending_section} {label}".strip(),
                "indent": 0,
                "bold": True,
                "section": True,
                "cells": [],
                "_x": line.label_x,
            })
            pending_section = ""
            pending_label = None
            continue

        label_x = line.label_x
        if pending_label:
            label = f"{pending_label} {label}".strip()
            if pending_x is not None:
                label_x = pending_x
            pending_label = None
        rows.append({
            "label": label or "—",
            "indent": 0,
            "bold": line.bold,
            "section": False,
            "cells": cells,
            "_x": label_x,
        })

    # Сноски после последней строки с данными в таблицу не входят.
    while rows and rows[-1]["section"]:
        rows.pop()
    if not any(row["cells"] for row in rows):
        return []

    _set_indents(rows)
    return rows


def _parse_continuation(
    lines: list[Line],
    heading_idx: int,
    columns: list[Column],
) -> list[dict]:
    """Строки продолжения таблицы по колонкам с её первой страницы.

    Продолжение («… (продолжение)») повторяет тот же шаблон, но шапка
    может распознаться с другим числом колонок (например, без «Прим.»).
    Поэтому строки режем по геометрии базовой страницы.
    """
    zone = lines[heading_idx + 1:]
    if not zone:
        return []
    units_index = next(
        (i for i, line in enumerate(zone) if _UNITS_RE.search(line.text)),
        None,
    )
    start = _data_start(
        zone, columns,
        min_index=(units_index + 1) if units_index is not None else 0,
    )
    if start is None:
        return []
    return _parse_rows(zone[start:], columns)


def _parse_table(
    lines: list[Line],
    heading_idx: int,
    page_number: int,
    definition: dict,
    ocr: bool = False,
) -> Optional[dict]:
    """Разбирает таблицу ниже заголовка на строки и колонки."""
    heading_line = lines[heading_idx]
    zone = lines[heading_idx + 1:]
    if not zone:
        return None

    columns = _build_columns(zone, heading_line.page_width)
    if not columns:
        return None

    # Строка единиц измерения отделяет подзаголовок документа от шапки
    # таблицы: над ней стоит «за шесть месяцев, закончившихся 30 июня
    # 2025 г. (не прошедший аудит)», ниже — только подписи колонок.
    units_index: Optional[int] = None
    for index, line in enumerate(zone):
        if _UNITS_RE.search(line.text):
            units_index = index
            break

    start = _data_start(
        zone, columns,
        min_index=(units_index + 1) if units_index is not None else 0,
    )
    if start is None:
        return None

    # Шапка — подписи колонок над первыми данными. Между шапкой и данными
    # может стоять строка-раздел («Выручка от реализации»): она относится
    # к строкам таблицы, а не к названиям колонок. Строки выше единиц
    # измерения (заголовок и подзаголовок документа) в таблицу не входят.
    pre_data = zone[:start]
    lower_bound = (units_index + 1) if units_index is not None else 0
    header_lines: list[Line] = []
    pre_rows: list[Line] = []
    for index, line in enumerate(pre_data):
        if index < lower_bound:
            continue
        if _is_headerish(line):
            header_lines.append(line)
            continue
        # Строка-раздел стоит у левого края. Жирные/нежирные подписи блоков
        # (даты, «капитал, относящийся к акционерам») — это шапка.
        if (
            line.label_x <= columns[0].left
            and not _GROUP_HEADER_RE.search(line.text)
        ):
            pre_rows.append(line)
        else:
            header_lines.append(line)
    row_lines = pre_rows + zone[start:]
    units = zone[units_index].text if units_index is not None else ""

    # Годы из строки «2026 2025» — запасные названия, если подписи не нашлись.
    fallback_years: dict[int, str] = {}
    for line in header_lines:
        if line.tokens and all(_is_number(t.text) for t in line.tokens):
            for token in line.tokens:
                if _is_year(token.text):
                    index = _header_column(columns, token)
                    if index is not None:
                        fallback_years.setdefault(index, token.text)

    left_name, column_names = _header_names(header_lines, columns, fallback_years, ocr=ocr)

    rows = _parse_rows(row_lines, columns)

    # Колонка «Примечания» (номера примечаний к статьям) — не данные
    # отчётности: в таблице она только мешает. OCR читает её как «Прим.».
    keep = [
        i for i, name in enumerate(column_names)
        if not re.search(r"примечан|^прим\.?(\s|$)|^стр\.?\s*\d", name or "", re.IGNORECASE)
    ]
    if keep and len(keep) < len(column_names):
        column_names = [column_names[i] for i in keep]
        for row in rows:
            if row["cells"]:
                row["cells"] = [row["cells"][i] for i in keep]

    return {
        "key": definition["key"],
        "title": definition["label"],
        "raw_title": heading_line.text,
        "page": page_number,
        "units": units,
        "columns": [left_name] + column_names,
        "rows": rows,
        # Индексы колонок, оставшихся после отбрасывания «Прим.» — нужны,
        # чтобы так же отфильтровать строки продолжения таблицы.
        "_keep": keep,
    }


def _scan_pages(pages: list[list[Line]]) -> list[int]:
    """Номера страниц без текстового слоя (сканы) — 1-based."""
    return [i + 1 for i, lines in enumerate(pages) if not lines]


def _toc_entries(pages: list[list[Line]]) -> dict[int, str]:
    """Страница -> название раздела по оглавлению (если оно есть в PDF)."""
    for lines in pages[:8]:
        text = " ".join(line.text for line in lines)
        if not _is_toc_page(text):
            continue
        mapping: dict[int, str] = {}
        for line in lines:
            match = re.match(r"(.+?)[\s.]{1,}(\d{1,3})\s*$", line.text)
            if match:
                title = _clean(match.group(1))
                if title:
                    mapping[int(match.group(2))] = title
        if mapping:
            return mapping
    return {}


# =============================================================================
# OCR СТРАНИЦ-СКАНОВ
#
# Многие эмитенты публикуют отчётность сканом (текстового слоя нет —
# например, Интер РАО). Для таких страниц используется встроенный OCR
# Windows (Windows.Media.Ocr, языковой пакет «ru»), вызываемый через
# services/ocr.ps1: страница рендерится в PNG, слова возвращаются с
# координатами и попадают в тот же табличный парсер, что и текстовый слой.
#
# Если OCR недоступен (не Windows / нет языкового пакета) — раздел честно
# сообщает, что нужен OCR, и продолжает работать с текстовыми страницами.
# =============================================================================
_OCR_SCRIPT = Path(__file__).with_name("ocr.ps1")
_OCR_DPI = 400
_OCR_MAX_PAGES = 24
_OCR_TIMEOUT = 240
_OCR_NUM_CHARS = set("0123456789()[]-−–—.,%'’ \u00a0")


def _ocr_supported() -> bool:
    return sys.platform == "win32" and _OCR_SCRIPT.exists()


def _ocr_numeric(text: str) -> bool:
    """Похоже ли слово OCR на число (включая половину «(416» / «623)»)."""
    raw = text.strip()
    return bool(raw) and any(ch.isdigit() for ch in raw) and all(
        ch in _OCR_NUM_CHARS for ch in raw
    )


def _ocr_page_lines(
    raw_lines: list[dict],
    scale: float,
    page_width: float,
) -> list[Line]:
    """Слова OCR -> строки/токены в координатах PDF.

    OCR отдаёт числа по частям («430» + «059»), поэтому соседние
    числовые слова склеиваются обратно в одну ячейку. Группировка по Y
    нужна потому, что OCR часто кладёт числа правой колонки в отдельную
    «строку» — парсеру же нужна вся строка таблицы целиком.
    """
    words: list[dict] = []
    for raw_line in raw_lines:
        for raw in raw_line.get("words") or []:
            text = _clean(str(raw.get("t") or ""))
            if not text:
                continue
            try:
                x = float(raw.get("x") or 0.0) * scale
                y = float(raw.get("y") or 0.0) * scale
                width = float(raw.get("w") or 0.0) * scale
                height = float(raw.get("h") or 0.0) * scale
            except (TypeError, ValueError):
                continue
            words.append({
                "text": text,
                "x0": x, "x1": x + width,
                "y0": y, "y1": y + height,
            })
    if not words:
        return []

    words.sort(key=lambda word: ((word["y0"] + word["y1"]) / 2, word["x0"]))

    groups: list[dict] = []
    for word in words:
        center = (word["y0"] + word["y1"]) / 2
        tolerance = max(1.5, (word["y1"] - word["y0"]) * 0.6)
        if groups and abs(center - groups[-1]["center"]) <= tolerance:
            group = groups[-1]
            group["words"].append(word)
            group["center"] = (
                group["center"] * (len(group["words"]) - 1) + center
            ) / len(group["words"])
        else:
            groups.append({"center": center, "words": [word]})

    lines: list[Line] = []
    for group in groups:
        merged: list[dict] = []
        for word in sorted(group["words"], key=lambda item: item["x0"]):
            if merged:
                previous = merged[-1]
                gap = word["x0"] - previous["x1"]
                limit = max(1.5, (word["y1"] - word["y0"]) * 0.7)
                if (
                    _ocr_numeric(previous["text"])
                    and _ocr_numeric(word["text"])
                    and gap <= limit
                ):
                    previous["text"] += " " + word["text"]
                    previous["x1"] = max(previous["x1"], word["x1"])
                    previous["y0"] = min(previous["y0"], word["y0"])
                    previous["y1"] = max(previous["y1"], word["y1"])
                    continue
            merged.append(dict(word))

        if not merged:
            continue
        size = median([token["y1"] - token["y0"] for token in merged]) or 8.0
        tokens = [
            Token(
                text=token["text"], x0=token["x0"], x1=token["x1"],
                y0=token["y0"], y1=token["y1"], size=size, bold=False,
            )
            for token in merged
        ]
        lines.append(Line(tokens=tokens, y=group["center"], page_width=page_width))

    lines.sort(key=lambda line: line.y)
    return lines


def _run_windows_ocr(document, page_indices: list[int]) -> dict[int, list[Line]]:
    """Распознаёт указанные страницы через Windows OCR (services/ocr.ps1)."""
    if not page_indices:
        return {}

    with tempfile.TemporaryDirectory(prefix="reports_ocr_") as folder:
        scales: dict[int, float] = {}
        for page_idx in page_indices:
            page = document[page_idx]
            pixmap = page.get_pixmap(dpi=_OCR_DPI)
            pixmap.save(str(Path(folder) / f"p{page_idx + 1:04d}.png"))
            scales[page_idx] = (
                page.rect.width / pixmap.width if pixmap.width else 0.24
            )

        out_path = Path(folder) / "ocr.json"
        command = [
            "powershell", "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(_OCR_SCRIPT),
            "-ImageDir", folder,
            "-OutFile", str(out_path),
        ]
        completed = subprocess.run(
            command, capture_output=True, text=True, timeout=_OCR_TIMEOUT,
        )
        if completed.returncode != 0:
            message = (completed.stderr or completed.stdout or "OCR failed").strip()
            raise RuntimeError(message[:300])
        if not out_path.exists():
            raise RuntimeError("OCR не вернул результат")

        payload = json.loads(out_path.read_text(encoding="utf-8-sig"))
        if isinstance(payload, list):
            entries = payload
        elif isinstance(payload, dict) and isinstance(payload.get("files"), list):
            entries = payload["files"]
        elif isinstance(payload, dict):
            entries = [payload]
        else:
            entries = []
        result: dict[int, list[Line]] = {}
        for entry in entries:
            match = re.match(r"p(\d+)\.png", entry.get("name") or "")
            if not match:
                continue
            page_idx = int(match.group(1)) - 1
            scale = scales.get(page_idx)
            if not scale:
                continue
            lines = _ocr_page_lines(
                entry.get("lines") or [], scale, document[page_idx].rect.width,
            )
            if lines:
                result[page_idx] = lines
        return result


def parse_pdf(data: bytes, source_name: str) -> dict:
    """Разбирает PDF и возвращает таблицы + пояснения (без записи в БД)."""
    if fitz is None:
        raise ValueError(
            "Для разбора PDF не установлен PyMuPDF. "
            "Выполните: pip install -r backend/requirements.txt"
        )
    try:
        document = fitz.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001 — битый/зашифрованный файл
        raise ValueError(
            f"Не удалось открыть PDF «{source_name}» — файл повреждён или это не PDF."
        ) from exc

    try:
        if document.needs_pass:
            raise ValueError(f"PDF «{source_name}» защищён паролем")
        pages = [_page_lines(page) for page in document]
        page_count = document.page_count

        # Страницы-сканы (нет текстового слоя) пробуем распознать OCR.
        # Ошибка OCR не должна ломать загрузку: остаётся текстовый слой
        # и пояснение, что для сканов нужен OCR.
        blank_pages = [idx for idx, lines in enumerate(pages) if not lines]
        ocr_pages: set[int] = set()
        ocr_error = ""
        if blank_pages and _ocr_supported():
            try:
                recognized = _run_windows_ocr(
                    document, blank_pages[:_OCR_MAX_PAGES],
                )
            except Exception as exc:  # noqa: BLE001 — OCR не критичен
                recognized = {}
                ocr_error = str(exc)
                logger.warning("OCR страниц-сканов не сработал: %s", exc)
            for page_idx, lines in recognized.items():
                if lines:
                    pages[page_idx] = lines
                    ocr_pages.add(page_idx)
    finally:
        document.close()

    if not any(pages):
        message = f"В PDF «{source_name}» нет текстового слоя — это скан."
        if not _ocr_supported():
            message += " Для распознавания нужен OCR."
        elif ocr_error:
            message += f" OCR не сработал: {ocr_error}"
        else:
            message += " Распознать страницы не удалось."
        raise ValueError(message)

    tables: list[dict] = []
    continuation_notes: list[dict] = []
    for definition in _TABLE_DEFS:
        pattern = re.compile(definition["pattern"], re.IGNORECASE)

        # Все страницы, где встречается заголовок таблицы. Одна таблица
        # может занимать несколько страниц («… (продолжение)»), поэтому
        # фрагменты склеиваются, а не выбирается один «лучший».
        fragments: list[tuple[int, int, dict]] = []
        for page_idx, lines in enumerate(pages):
            if not lines:
                continue
            heading_idx = _find_heading(lines, pattern)
            if heading_idx is None:
                continue
            table = _parse_table(
                lines, heading_idx, page_idx + 1, definition,
                ocr=page_idx in ocr_pages,
            )
            if table and any(row["cells"] for row in table["rows"]):
                fragments.append((page_idx, heading_idx, table))
        if not fragments:
            continue

        fragments.sort(key=lambda item: item[0])

        # Соседние страницы — одна таблица. Самую длинную цепочку берём
        # как отчётность, чтобы случайное упоминание названия в примечаниях
        # на отдельной странице не превратилось в «таблицу».
        runs: list[list[tuple[int, int, dict]]] = []
        for page_idx, heading_idx, table in fragments:
            if runs and page_idx == runs[-1][-1][0] + 1:
                runs[-1].append((page_idx, heading_idx, table))
            else:
                runs.append([(page_idx, heading_idx, table)])
        run = max(runs, key=lambda items: sum(len(t["rows"]) for _, _, t in items))

        base_page_idx, base_heading_idx, base = run[0]
        base_columns = _build_columns(
            pages[base_page_idx][base_heading_idx + 1:],
            pages[base_page_idx][base_heading_idx].page_width,
        )
        base_keep = base.get("_keep") or list(range(len(base_columns)))
        base_pages = [base["page"]]

        for page_idx, heading_idx, fragment in run[1:]:
            # Продолжение режем по геометрии колонок базовой страницы —
            # шапка на продолжении может распознаться иначе (без «Прим.»).
            alt_rows = (
                _parse_continuation(pages[page_idx], heading_idx, base_columns)
                if base_columns else []
            )
            if alt_rows and base_keep and len(base_keep) < len(base_columns):
                for row in alt_rows:
                    if row["cells"]:
                        row["cells"] = [row["cells"][i] for i in base_keep]

            own_cells = sum(
                1 for row in fragment["rows"] for cell in row["cells"] if cell
            )
            alt_cells = sum(
                1 for row in alt_rows for cell in row["cells"] if cell
            )
            if alt_rows and alt_cells >= own_cells:
                base["rows"].extend(alt_rows)
                base_pages.append(fragment["page"])
            elif len(fragment["columns"]) == len(base["columns"]):
                base["rows"].extend(fragment["rows"])
                base_pages.append(fragment["page"])
            else:
                continuation_notes.append({
                    "title": definition["label"],
                    "page": fragment["page"],
                    "reason": "Продолжение таблицы на другой странице "
                              "не удалось совместить с первой частью.",
                })
                continue

        base.pop("_keep", None)
        base["pages"] = base_pages
        base["ocr"] = any((page - 1) in ocr_pages for page in base_pages)
        base["source"] = source_name
        tables.append(base)

    notes: list[dict] = list(continuation_notes)
    if ocr_pages:
        ocr_text = ", ".join(str(page + 1) for page in sorted(ocr_pages)[:10])
        notes.insert(0, {
            "title": "Распознавание OCR",
            "reason": (
                f"Страницы-сканы (стр. {ocr_text}) распознаны встроенным OCR "
                "Windows — проверяйте числа по исходному PDF."
            ),
        })
        if len(blank_pages) > _OCR_MAX_PAGES:
            notes.insert(1, {
                "title": "OCR обработал не все страницы",
                "reason": (
                    f"Страниц-сканов {len(blank_pages)}, распознаны первые "
                    f"{_OCR_MAX_PAGES} — остальные не попали в таблицы."
                ),
            })
    scanned = _scan_pages(pages)
    toc = _toc_entries(pages)
    found_keys = {table["key"] for table in tables}
    for definition in _TABLE_DEFS:
        if definition["key"] in found_keys:
            continue
        pattern = re.compile(definition["pattern"], re.IGNORECASE)
        toc_page = next(
            (page for page, title in toc.items() if pattern.search(title)),
            None,
        )
        if toc_page in scanned:
            notes.append({
                "title": definition["label"],
                "page": toc_page,
                "reason": "Страница без текстового слоя (скан) — для распознавания нужен OCR.",
            })
        elif toc_page:
            notes.append({
                "title": definition["label"],
                "page": toc_page,
                "reason": "Таблица найдена в оглавлении, но распознать её не удалось.",
            })
        elif scanned:
            scanned_text = ", ".join(str(page) for page in scanned[:5])
            notes.append({
                "title": definition["label"],
                "reason": (
                    "Таблица не найдена в текстовом слое — возможно, она на "
                    f"странице-скане (стр. {scanned_text}). Для распознавания нужен OCR."
                ),
            })

    return {
        "source": source_name,
        "pages": page_count,
        "scanned_pages": scanned,
        "tables": tables,
        "notes": notes,
    }


def extract_pdfs(filename: str, data: bytes) -> list[tuple[str, bytes]]:
    """Достаёт PDF из загруженного файла: сам PDF или ZIP с PDF внутри."""
    safe_name = Path(filename or "report").name
    lowered = safe_name.lower()

    if lowered.endswith(".zip") or data[:2] == b"PK":
        try:
            archive = zipfile.ZipFile(io.BytesIO(data))
        except zipfile.BadZipFile as exc:
            raise ValueError("Файл не похож на ZIP-архив") from exc
        result: list[tuple[str, bytes]] = []
        total = 0
        with archive:
            for info in archive.infolist():
                if info.is_dir() or "__MACOSX" in info.filename:
                    continue
                if not info.filename.lower().endswith(".pdf"):
                    continue
                total += info.file_size
                if total > MAX_ARCHIVE_BYTES:
                    raise ValueError("Распакованный архив слишком большой (более 120 МБ)")
                if len(result) >= MAX_PDFS_PER_ARCHIVE:
                    break
                result.append((Path(info.filename).name, archive.read(info)))
        if not result:
            raise ValueError("В ZIP-архиве нет PDF-файлов")
        return result

    if not lowered.endswith(".pdf") or data[:4] != b"%PDF":
        raise ValueError("Поддерживаются только PDF и ZIP с PDF")
    return [(safe_name, data)]


# =============================================================================
# ХРАНЕНИЕ
# =============================================================================

def _period_from(tables: list[dict]) -> str:
    """Подписи периодов для списка загрузок.

    В заголовках колонок («За шесть месяцев, закончившихся 30 июня 2025»)
    полезнее всего годы: полные подписи в истории загрузок не помещаются.
    Если годов в названиях нет (например, колонки капитала) — показываем
    сами названия.
    """
    for table in tables:
        columns = [c for c in table.get("columns", [])[1:] if c]
        years: list[str] = []
        for column in columns:
            for match in re.finditer(r"\b(?:19|20)\d{2}\b", column):
                if match.group(0) not in years:
                    years.append(match.group(0))
        if len(years) >= 2:
            return " / ".join(years)
        if columns and not any(c.startswith("Значение") for c in columns):
            return " / ".join(columns)
    return ""


def _document_to_dict(row: ReportDocument) -> dict:
    try:
        tables = json.loads(row.tables_json or "[]")
    except json.JSONDecodeError:
        tables = []
    try:
        notes = json.loads(row.notes_json or "[]")
    except json.JSONDecodeError:
        notes = []
    try:
        columns = json.loads(row.columns_json or "[]")
    except json.JSONDecodeError:
        columns = []
    return {
        "id": row.id,
        "filename": row.filename,
        "ticker": row.ticker or "",
        "period": row.period or "",
        "pages": row.pages or 0,
        "tables": tables,
        "columns": columns,
        "notes": notes,
        "uploaded_at": (row.uploaded_at.isoformat() + "Z") if row.uploaded_at else "",
    }


def ingest_upload(filename: str, data: bytes,
                  ticker: str | None = None) -> dict:
    """Разбирает загруженный PDF/ZIP, сохраняет таблицы в БД и отдаёт запись.

    ticker — бумага, выбранная в разделе «Отчетность». Если он передан,
    загрузка становится колонками её таблицы показателей; без ticker
    документ сохраняется в общую историю (совместимость со старыми
    вызовами и загрузками без компании).
    """
    if len(data) > MAX_UPLOAD_BYTES:
        raise ValueError("Файл слишком большой (максимум 30 МБ)")

    symbol = None
    if ticker:
        symbol = report_metrics_service.canonical_symbol(ticker)
        if not symbol:
            raise ValueError(
                "Выберите бумагу Мосбиржи — для криптовалют отчётность "
                "не поддерживается"
            )

    files = extract_pdfs(filename, data)
    tables: list[dict] = []
    notes: list[dict] = []
    columns: list[dict] = []
    pages_total = 0
    for name, pdf_bytes in files:
        parsed = parse_pdf(pdf_bytes, name)
        tables.extend(parsed["tables"])
        notes.extend(parsed["notes"])
        pages_total += parsed["pages"]
        columns.extend(report_metrics_service.build_columns(parsed["tables"]))

    if not tables:
        reason = notes[0]["reason"] if notes else "таблицы отчётности не найдены"
        raise ValueError(f"Таблицы не распознаны: {reason}")

    # ZIP может содержать несколько PDF; один и тот же период (например,
    # год из годового отчёта и из баланса промежуточного) должен остаться
    # одной колонкой. Более поздний файл уточняет значения.
    merged_columns: dict[str, dict] = {}
    for column in columns:
        key = str(column.get("key") or "")
        if not key:
            continue
        existing = merged_columns.get(key)
        if existing is None:
            merged_columns[key] = column
            continue
        merged = dict(existing)
        merged.update({
            field: column.get(field)
            for field in ("label", "full_label", "kind", "year",
                          "quarter", "end", "sort")
            if column.get(field) is not None
        })
        values = dict(existing.get("values") or {})
        values.update(column.get("values") or {})
        merged["values"] = values
        merged_columns[key] = merged
    columns = sorted(
        merged_columns.values(),
        key=lambda column: int(column.get("sort") or 0),
    )

    if symbol and not columns:
        raise ValueError(
            "Таблицы распознаны, но периоды финансовых показателей не "
            "найдены. Нужен документ с ОПиУ, ДДС или балансом."
        )

    period = _period_from(tables)
    with get_session() as db:
        record = ReportDocument(
            filename=Path(filename or "report").name,
            ticker=symbol,
            period=period,
            pages=pages_total,
            tables_json=json.dumps(tables, ensure_ascii=False),
            columns_json=json.dumps(columns, ensure_ascii=False),
            notes_json=json.dumps(notes, ensure_ascii=False),
            uploaded_at=datetime.utcnow(),
        )
        db.add(record)
        db.commit()
        db.refresh(record)
        return _document_to_dict(record)


def list_documents() -> list[dict]:
    """История загрузок: без самих таблиц (они тяжёлые), только шапка."""
    with get_session() as db:
        rows = db.query(ReportDocument).order_by(ReportDocument.id.desc()).all()
        result = []
        for row in rows:
            entry = _document_to_dict(row)
            entry.pop("tables", None)
            entry.pop("notes", None)
            result.append(entry)
        return result


def get_document(report_id: int) -> Optional[dict]:
    with get_session() as db:
        row = db.query(ReportDocument).filter(ReportDocument.id == report_id).first()
        return _document_to_dict(row) if row else None


def delete_document(report_id: int) -> bool:
    with get_session() as db:
        row = db.query(ReportDocument).filter(ReportDocument.id == report_id).first()
        if not row:
            return False
        db.delete(row)
        db.commit()
        return True
