"""
Hand-built PDF fixtures for decode paths no generator here produces.

identity_h.pdf
    A Type0 font with /Encoding /Identity-H: character codes are two
    bytes wide and mean nothing without the /ToUnicode CMap. This is what
    every PDF exported from Word with an embedded font looks like, and
    getting it wrong yields fluent-looking nonsense rather than an error.
    The CMap deliberately uses all three destination forms — bfchar,
    a bfrange with a base value, and a bfrange with an explicit array.

no_text_layer.pdf
    A page whose content stream draws only a filled rectangle. Parses
    cleanly, contains no text. Must be reported as a scan, not returned
    as an empty document.
"""
import os
import zlib

OUT = os.path.join(os.path.dirname(__file__), "..", "tests", "fixtures")

# Codes are assigned so that each ToUnicode form carries part of the text.
TEXT = "SAP Clean Core — RAP behaviour definition"

# Map each distinct character to a two-byte CID starting at 0x0100.
CHARS = []
for ch in TEXT:
    if ch not in CHARS:
        CHARS.append(ch)
CID = {ch: 0x0100 + i for i, ch in enumerate(CHARS)}


def build_tounicode():
    """Split the mapping across bfchar / bfrange-base / bfrange-array."""
    items = sorted(CID.items(), key=lambda kv: kv[1])

    third = max(1, len(items) // 3)
    by_char = items[:third]
    by_range_base = items[third: third * 2]
    by_range_array = items[third * 2:]

    out = [
        "/CIDInit /ProcSet findresource begin",
        "12 dict begin begincmap",
        "/CMapName /Custom-UCS2 def",
        "/CMapType 2 def",
        "1 begincodespacerange",
        "<0000> <FFFF>",
        "endcodespacerange",
    ]

    if by_char:
        out.append(f"{len(by_char)} beginbfchar")
        for ch, cid in by_char:
            out.append(f"<{cid:04X}> <{ord(ch):04X}>")
        out.append("endbfchar")

    # A base-form bfrange is only correct for a contiguous run whose
    # Unicode values are also contiguous, so emit one entry per code.
    if by_range_base:
        out.append(f"{len(by_range_base)} beginbfrange")
        for ch, cid in by_range_base:
            out.append(f"<{cid:04X}> <{cid:04X}> <{ord(ch):04X}>")
        out.append("endbfrange")

    if by_range_array:
        out.append(f"{len(by_range_array)} beginbfrange")
        for ch, cid in by_range_array:
            out.append(f"<{cid:04X}> <{cid:04X}> [<{ord(ch):04X}>]")
        out.append("endbfrange")

    out += ["endcmap", "CMapName currentdict /CMap defineresource pop", "end", "end"]
    return "\n".join(out).encode("latin1")


def hex_string(text):
    return "<" + "".join(f"{CID[ch]:04X}" for ch in text) + ">"


def build_pdf(objects, root_number):
    """Assembles numbered objects into a valid PDF with an xref table."""
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}

    for number in sorted(objects):
        offsets[number] = len(out)
        out += f"{number} 0 obj\n".encode("latin1")
        out += objects[number]
        out += b"\nendobj\n"

    xref_at = len(out)
    highest = max(objects) + 1

    out += f"xref\n0 {highest}\n".encode("latin1")
    out += b"0000000000 65535 f \n"
    for number in range(1, highest):
        if number in offsets:
            out += f"{offsets[number]:010d} 00000 n \n".encode("latin1")
        else:
            out += b"0000000000 65535 f \n"

    out += f"trailer\n<< /Size {highest} /Root {root_number} 0 R >>\n".encode("latin1")
    out += f"startxref\n{xref_at}\n%%EOF\n".encode("latin1")
    return bytes(out)


def stream_object(dictionary, payload, compress=True):
    if compress:
        payload = zlib.compress(payload)
        dictionary = dictionary.rstrip()[:-2] + " /Filter /FlateDecode >>"
    dictionary = dictionary.replace("__LEN__", str(len(payload)))
    return dictionary.encode("latin1") + b"\nstream\n" + payload + b"\nendstream"


def build_identity_h():
    content = (
        b"BT\n/F1 14 Tf\n60 700 Td\n"
        + hex_string(TEXT).encode("latin1")
        + b" Tj\nET\n"
    )

    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
           b"/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        4: stream_object("<< /Length __LEN__ >>", content),
        5: b"<< /Type /Font /Subtype /Type0 /BaseFont /AAAAAA+Test "
           b"/Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>",
        6: b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /AAAAAA+Test "
           b"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> "
           b"/DW 1000 >>",
        7: stream_object("<< /Length __LEN__ >>", build_tounicode()),
    }

    with open(os.path.join(OUT, "identity_h.pdf"), "wb") as fh:
        fh.write(build_pdf(objects, 1))

    with open(os.path.join(OUT, "identity_h.expected.txt"), "w", encoding="utf8") as fh:
        fh.write("[Page 1]\n" + TEXT)


def build_no_text_layer():
    content = b"0.2 0.4 0.8 rg\n60 600 400 180 re\nf\n"

    objects = {
        1: b"<< /Type /Catalog /Pages 2 0 R >>",
        2: b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        3: b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
           b"/Resources << >> /Contents 4 0 R >>",
        4: stream_object("<< /Length __LEN__ >>", content),
    }

    with open(os.path.join(OUT, "no_text_layer.pdf"), "wb") as fh:
        fh.write(build_pdf(objects, 1))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    build_identity_h()
    build_no_text_layer()
    print("special fixtures written")
