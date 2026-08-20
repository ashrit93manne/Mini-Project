"""
Generates the PDF fixtures the extractor is regression-tested against.

Three variants, because they exercise genuinely different decode paths:
  simple    - Helvetica / WinAnsiEncoding, single-byte codes, no ToUnicode
  embedded  - embedded TrueType subset, Identity-H, 2-byte codes + ToUnicode
  objstm    - PDF 1.5 compressed object streams (page/font dicts packed away)

Each fixture is written alongside a .expected.txt holding the exact text
that was drawn, so the test asserts against ground truth rather than
against whatever the parser happened to produce.
"""
import os
import sys

from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures")

LINES_PAGE1 = [
    "Code Companion Requirements",
    "1. The report must read table ZSD_ORDERS via a released CDS view.",
    "2. Authorization object S_TABU_NAM is checked before selection.",
    'Quotes: "curly" and ‘single’ — em-dash, en–dash, ellipsis…',
    "Symbols: 50% of €1,234.56 ± 0.5 °C © NTT DATA",
    "Package: ZLOCAL   Transport: DEVK900123",
]

LINES_PAGE2 = [
    "Appendix A - Field Mapping",
    "VBELN  Sales Document  CHAR(10)",
    "POSNR  Item Number     NUMC(6)",
    "MATNR  Material        CHAR(40)",
]


def draw(c, font_name, size=11):
    for page_lines in (LINES_PAGE1, LINES_PAGE2):
        c.setFont(font_name, size)
        y = A4[1] - 80
        for line in page_lines:
            c.drawString(60, y, line)
            y -= 22
        c.showPage()


def expected_text():
    return "\n".join(
        ["[Page 1]"] + LINES_PAGE1 + ["", "[Page 2]"] + LINES_PAGE2
    )


def write_expected(name):
    with open(os.path.join(OUT, name + ".expected.txt"), "w", encoding="utf8") as fh:
        fh.write(expected_text())


def build_simple():
    path = os.path.join(OUT, "simple.pdf")
    c = canvas.Canvas(path, pagesize=A4)
    draw(c, "Helvetica")
    c.save()
    write_expected("simple")


def build_embedded():
    path = os.path.join(OUT, "embedded.pdf")
    pdfmetrics.registerFont(
        TTFont("DejaVu", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")
    )
    c = canvas.Canvas(path, pagesize=A4)
    draw(c, "DejaVu")
    c.save()
    write_expected("embedded")


def build_objstm():
    """reportlab writes object streams when compression + PDF 1.5 are on."""
    path = os.path.join(OUT, "objstm.pdf")
    c = canvas.Canvas(path, pagesize=A4, pageCompression=1)
    c.setPageCompression(1)
    draw(c, "Helvetica")
    c.save()
    write_expected("objstm")


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    build_simple()
    build_embedded()
    build_objstm()
    print("fixtures written to", os.path.abspath(OUT))
