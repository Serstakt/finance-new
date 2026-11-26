"""Проверка раздела «Отчетность» (services/reports_service.py).

Тест собирает PDF в памяти (PyMuPDF) со структурой, типичной для
бухгалтерской отчётности, и проверяет, что парсер:
  • находит таблицу «Отчет о прибылях и убытках» и её колонки;
  • отличает шапку от строки-раздела и не тащит годы в данные;
  • склеивает перенос названия статьи на следующую строку;
  • сохраняет отрицательные значения в скобках как есть;
  • помечает жирные итоги;
  • достаёт PDF из ZIP и отвергает неподдерживаемые файлы.

Запуск: python -m backend.tests_reports
"""
import io
import zipfile

import pymupdf

from backend.services import reports_service as svc

# Шрифт с кириллицей: на Windows — Arial, на Linux — DejaVu.
FONT_PAIRS = [
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
     "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
     "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
]

failures = 0


def check(cond, msg):
    global failures
    print(("PASS: " if cond else "FAIL: ") + msg)
    if not cond:
        failures += 1


def find_fonts():
    for regular, bold in FONT_PAIRS:
        try:
            return pymupdf.Font(fontfile=regular), pymupdf.Font(fontfile=bold), regular, bold
        except Exception:  # noqa: BLE001 — шрифта нет, пробуем следующий
            continue
    return None


def build_pdf(regular, bold, regular_path, bold_path) -> bytes:
    """PDF с одной таблицей: шапка, раздел, данные, перенос, итоги."""
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)

    def put(x, y, text, is_bold=False, size=9):
        page.insert_text(
            (x, y), text,
            fontname="f-bold" if is_bold else "f-reg",
            fontfile=bold_path if is_bold else regular_path,
            fontsize=size,
        )

    def right(x_right, y, text, is_bold=False, size=9):
        font = bold if is_bold else regular
        put(x_right - font.text_length(text, size), y, text, is_bold, size)

    put(60, 70, "Раскрываемый консолидированный промежуточный сокращенный отчет")
    put(60, 84, "о прибылях и убытках")
    put(60, 106, "(в миллионах рублей)", size=8)
    put(60, 132, "Показатель", size=8)
    right(470, 132, "За 6 мес. 2026", size=8)
    right(550, 132, "За 6 мес. 2025", size=8)
    right(470, 148, "2026", size=8)
    right(550, 148, "2025", size=8)

    y = 175
    put(60, y, "Выручка от реализации", is_bold=True)
    y += 16
    put(70, y, "Выручка от реализации углеводородов")
    right(470, y, "816 587")
    right(550, y, "783 073")
    y += 16
    put(70, y, "Налоги, кроме налога на прибыль")
    right(470, y, "(153 487)")
    right(550, y, "(101 199)")
    y += 16
    put(70, y, "Экономия (расходы)")
    y += 16
    put(70, y, "по отложенному налогу на прибыль, нетто")
    right(470, y, "13 635")
    right(550, y, "20 368")
    y += 16
    put(60, y, "Прибыль", is_bold=True)
    right(470, y, "221 013", is_bold=True)
    right(550, y, "227 291", is_bold=True)

    data = doc.tobytes()
    doc.close()
    return data


fonts = find_fonts()
if fonts is None:
    print("SKIP: не найден шрифт с кириллицей (Arial/DejaVu/Liberation)")
    raise SystemExit(0)

pdf_bytes = build_pdf(*fonts)
parsed = svc.parse_pdf(pdf_bytes, "fixture.pdf")

# =============================================================================
# 1. Таблица найдена, колонки распознаны
# =============================================================================
check(len(parsed["tables"]) == 1, "найдена одна таблица")
income = parsed["tables"][0] if parsed["tables"] else {}
check(income.get("key") == "income", "таблица — «Отчет о прибылях и убытках»")
check(income.get("page") == 1, "страница таблицы определена")
check(
    income.get("columns") == ["Показатель", "За 6 мес. 2026", "За 6 мес. 2025"],
    "колонки: подпись + два периода",
)
check(income.get("units") == "(в миллионах рублей)", "единицы измерения в шапке")

rows = income.get("rows", [])
labels = [row["label"] for row in rows]
cells_by_label = {row["label"]: row["cells"] for row in rows}

# =============================================================================
# 2. Структура строк
# =============================================================================
check(labels[:1] == ["Выручка от реализации"], "первая строка — раздел, а не шапка")
check(
    rows and rows[0]["section"] and rows[0]["bold"],
    "строка-раздел помечена как раздел и выделена",
)
check(
    cells_by_label.get("Выручка от реализации углеводородов") == ["816 587", "783 073"],
    "значения статьи извлечены в свои колонки",
)
check(
    cells_by_label.get("Налоги, кроме налога на прибыль") == ["(153 487)", "(101 199)"],
    "отрицательные значения сохранены в скобках",
)
check(
    "Экономия (расходы) по отложенному налогу на прибыль, нетто" in cells_by_label,
    "перенос названия статьи склеен в одну строку",
)
check(
    cells_by_label.get("Прибыль") == ["221 013", "227 291"],
    "итоговая строка на месте",
)
check(
    next((r["bold"] for r in rows if r["label"] == "Прибыль"), False),
    "жирный итог помечен bold",
)
check(
    next((r["indent"] for r in rows if r["label"] == "Выручка от реализации углеводородов"), 0) > 0,
    "подстатьи получили отступ",
)
check(
    not any("2026" == cell for row in rows for cell in row["cells"]),
    "строка годов не попала в данные",
)

# =============================================================================
# 3. ZIP и валидация файла
# =============================================================================
buffer = io.BytesIO()
with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
    archive.writestr("reports/Novatek.pdf", pdf_bytes)
files = svc.extract_pdfs("upload.zip", buffer.getvalue())
check(len(files) == 1 and files[0][0] == "Novatek.pdf", "PDF извлечён из ZIP")

try:
    svc.extract_pdfs("notes.txt", b"hello")
    check(False, "неподдерживаемый файл должен отвергаться")
except ValueError:
    check(True, "неподдерживаемый файл отвергается")

check(svc._period_from(parsed["tables"]) == "2026 / 2025", "периоды для истории загрузок")

print()
if failures:
    print(f"❌ Провалено проверок: {failures}")
    raise SystemExit(1)
print("✅ Все проверки раздела «Отчетность» пройдены")
