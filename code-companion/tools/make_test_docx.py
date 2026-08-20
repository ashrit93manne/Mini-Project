"""
Builds tests/fixtures/sample.docx by writing the OOXML package directly.

Written by hand rather than with python-docx so the fixture can contain
exactly the constructs the parser has to survive — tracked deletions,
field instructions, a hand-numbered ListParagraph, a nested tab — several
of which a document library will not emit on request.
"""
import os
import zipfile

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures")

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'


def p(text, style=None, num=None, ilvl=0, raw=None):
    props = ""
    if style or num is not None:
        inner = ""
        if style:
            inner += f'<w:pStyle w:val="{style}"/>'
        if num is not None:
            inner += f'<w:numPr><w:ilvl w:val="{ilvl}"/><w:numId w:val="{num}"/></w:numPr>'
        props = f"<w:pPr>{inner}</w:pPr>"
    body = raw if raw is not None else f"<w:r><w:t>{text}</w:t></w:r>"
    return f"<w:p>{props}{body}</w:p>"


def cell(text):
    return f"<w:tc><w:tcPr><w:tcW w:w='3000' w:type='dxa'/></w:tcPr>{p(text)}</w:tc>"


def row(cells):
    return "<w:tr>" + "".join(cell(c) for c in cells) + "</w:tr>"


BODY = "".join([
    p("Interface Specification", style="Heading1"),
    p("This document describes the outbound interface."),

    p("Field Mapping", style="Heading2"),
    "<w:tbl><w:tblPr/><w:tblGrid/>"
    + row(["Field", "Type", "Description"])
    + row(["VBELN", "CHAR(10)", "Sales document"])
    + row(["POSNR", "NUMC(6)", "Item number"])
    + "</w:tbl>",

    p("Constraints", style="Heading2"),
    p("Released APIs only", style="ListBullet"),
    p("No modification of SAP standard objects", style="ListBullet"),

    p("Build Steps", style="Heading2"),
    p("Create the CDS interface view", num=1),
    p("Add the projection view", num=1),
    p("Bind the service", num=1),

    # Hand-numbered paragraph carrying the generic ListParagraph indent
    # style. Must NOT gain a bullet in front of the typed "1.".
    p("1. Understand the requirement", style="ListParagraph"),
    p("2. Generate the implementation", style="ListParagraph"),

    # Tab and explicit line break inside one paragraph.
    p(None, raw="<w:r><w:t>Package:</w:t></w:r><w:r><w:tab/></w:r>"
                "<w:r><w:t>ZLOCAL</w:t></w:r>"),
    p(None, raw="<w:r><w:t>Line one</w:t></w:r><w:r><w:br/></w:r>"
                "<w:r><w:t>Line two</w:t></w:r>"),

    # A field: the instruction text must be dropped, the display text kept.
    p(None, raw=(
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> HYPERLINK "https://sap.com" </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        '<w:r><w:t>SAP Clean Core guidance</w:t></w:r>'
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    )),
    p(None, raw='<w:r><w:instrText> PAGEREF _Toc1 </w:instrText></w:r>'),

    # Tracked deletion: <w:delText> must never reach the output.
    p(None, raw='<w:r><w:t>Kept text.</w:t></w:r>'
                '<w:del><w:r><w:delText> this was deleted</w:delText></w:r></w:del>'),

    # Content control wrapping a paragraph — content must still be seen.
    "<w:sdt><w:sdtContent>" + p("Inside a content control.") + "</w:sdtContent></w:sdt>",
])

DOCUMENT = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<w:document {W} {R}><w:body>{BODY}</w:body></w:document>'
)

# numId 1 -> abstract 0, whose level 0 is decimal (an ordered list).
NUMBERING = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    f'<w:numbering {W}>'
    '<w:abstractNum w:abstractNumId="0">'
    '<w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>'
    '<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>'
    '</w:abstractNum>'
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    '</w:numbering>'
)

CONTENT_TYPES = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    '</Types>'
)

RELS = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    '</Relationships>'
)

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    with zipfile.ZipFile(os.path.join(OUT, "sample.docx"), "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", CONTENT_TYPES)
        z.writestr("_rels/.rels", RELS)
        z.writestr("word/document.xml", DOCUMENT)
        z.writestr("word/numbering.xml", NUMBERING)
    print("sample.docx written")
