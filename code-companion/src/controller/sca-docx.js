/*
 * Code Companion — DOCX Text Extraction
 *
 * Version 1.0.0
 *
 * Reads word/document.xml out of the OOXML package and reconstructs the
 * document as Markdown-flavoured plain text: headings, paragraphs, list
 * items and tables, in reading order.
 *
 * Why Markdown rather than a flat text dump
 * -----------------------------------------
 * The extracted text is handed to the LLM as grounding material. A
 * requirements document's meaning is carried substantially by its
 * structure — a heading tells the model that what follows is a new
 * requirement, a table row tells it that these cells belong together.
 * Flattening a specification table into a stream of words routinely
 * causes the model to attribute a value to the wrong field. Markdown
 * costs a handful of extra characters and preserves that structure in a
 * notation every model already reads fluently.
 */

(function extendScaAttachmentsWithDocx(host) {
    "use strict";

    var internals = host.internals;

    var readZip = internals.readZip;
    var readZipEntryText = internals.readZipEntryText;
    var walkXml = internals.walkXml;
    var attachmentError = internals.attachmentError;
    var normaliseExtractedText = internals.normaliseExtractedText;

    /*
     * Word writes every element in the main WordprocessingML namespace,
     * conventionally bound to the "w" prefix. Comparing on the local
     * name keeps this working for the rare producer that binds a
     * different prefix.
     */
    function localName(name) {
        var separator = name.indexOf(":");

        return separator === -1 ? name : name.slice(separator + 1);
    }

    /* =========================================================
     * DOCX-01 — NUMBERING DEFINITIONS
     *
     * numbering.xml answers one question the parser needs: is this list
     * item a bullet or a number? Without it every list renders as "-",
     * which silently destroys the meaning of an ordered procedure —
     * "step 3" stops being identifiable as the third step.
     * ========================================================= */

    function parseNumbering(xml) {
        var numberingIdToAbstractId = {};
        var abstractLevelFormats = {};

        if (!xml) {
            return {
                formatFor: function () {
                    return "bullet";
                }
            };
        }

        var currentAbstractId = null;
        var currentNumberingId = null;
        var currentLevel = null;
        var inAbstractNumbering = false;

        walkXml(xml, function (token) {
            var name = token.name ? localName(token.name) : "";

            if (token.kind === "open") {
                var attributes = token.attributes || {};

                if (name === "abstractNum") {
                    inAbstractNumbering = true;
                    currentAbstractId = attributeValue(attributes, "abstractNumId");
                    abstractLevelFormats[currentAbstractId] = {};
                    return;
                }

                if (name === "num") {
                    inAbstractNumbering = false;
                    currentNumberingId = attributeValue(attributes, "numId");
                    return;
                }

                if (name === "abstractNumId" && currentNumberingId !== null) {
                    numberingIdToAbstractId[currentNumberingId] =
                        attributeValue(attributes, "val");
                    return;
                }

                if (name === "lvl" && inAbstractNumbering) {
                    currentLevel = attributeValue(attributes, "ilvl");
                    return;
                }

                if (
                    name === "numFmt" &&
                    inAbstractNumbering &&
                    currentAbstractId !== null &&
                    currentLevel !== null
                ) {
                    abstractLevelFormats[currentAbstractId][currentLevel] =
                        attributeValue(attributes, "val") || "bullet";
                }

                return;
            }

            if (token.kind === "close") {
                if (name === "abstractNum") {
                    inAbstractNumbering = false;
                    currentAbstractId = null;
                } else if (name === "num") {
                    currentNumberingId = null;
                } else if (name === "lvl") {
                    currentLevel = null;
                }
            }
        });

        return {
            formatFor: function (numberingId, level) {
                var abstractId = numberingIdToAbstractId[numberingId];
                var levels = abstractLevelFormats[abstractId];

                if (!levels) {
                    return "bullet";
                }

                return levels[String(level)] || levels["0"] || "bullet";
            }
        };
    }

    function attributeValue(attributes, wanted) {
        var keys = Object.keys(attributes);
        var index = 0;

        while (index < keys.length) {
            if (localName(keys[index]) === wanted) {
                return attributes[keys[index]];
            }

            index += 1;
        }

        return null;
    }

    /* =========================================================
     * DOCX-02 — DOCUMENT BODY
     * ========================================================= */

    function extractDocumentText(documentXml, numbering) {
        var blocks = [];

        /*
         * Table state is a stack so that a table nested inside a cell
         * (used constantly in SAP specification templates) does not
         * corrupt the enclosing table's row structure.
         */
        var tableStack = [];

        var paragraph = null;
        var textDepth = 0;

        /*
         * Field instructions, tracked deletions and the alternate
         * content of a drawing all carry <w:t>-like payloads that must
         * never reach the output.
         */
        var suppressDepth = 0;

        /* Ordered-list counters, keyed by "numId:level". */
        var listCounters = {};

        walkXml(documentXml, function (token) {
            var name = token.name ? localName(token.name) : "";

            if (token.kind === "text") {
                if (paragraph && textDepth > 0 && suppressDepth === 0) {
                    paragraph.parts.push(token.text);
                }

                return;
            }

            if (token.kind === "open") {
                handleOpen(name, token.attributes || {});
                return;
            }

            handleClose(name);
        });

        flushParagraph();

        return blocks.join("\n");

        function handleOpen(name, attributes) {
            if (suppressDepth > 0) {
                suppressDepth += 1;
                return;
            }

            switch (name) {
                case "instrText":
                case "delText":
                case "delInstrText":
                    suppressDepth = 1;
                    return;

                case "tbl":
                    flushParagraph();
                    tableStack.push({ rows: [], row: null, cell: null });
                    return;

                case "tr":
                    if (currentTable()) {
                        flushParagraph();
                        currentTable().row = [];
                    }
                    return;

                case "tc":
                    if (currentTable() && currentTable().row) {
                        flushParagraph();
                        currentTable().cell = [];
                    }
                    return;

                case "p":
                    flushParagraph();
                    paragraph = { parts: [], style: "", numberingId: null, level: 0 };
                    return;

                case "pStyle":
                    if (paragraph) {
                        paragraph.style = attributeValue(attributes, "val") || "";
                    }
                    return;

                case "numId":
                    if (paragraph) {
                        paragraph.numberingId = attributeValue(attributes, "val");
                    }
                    return;

                case "ilvl":
                    if (paragraph) {
                        paragraph.level =
                            parseInt(attributeValue(attributes, "val"), 10) || 0;
                    }
                    return;

                case "t":
                    textDepth += 1;
                    return;

                case "tab":
                    if (paragraph) {
                        paragraph.parts.push("\t");
                    }
                    return;

                case "br":
                case "cr":
                    if (paragraph) {
                        paragraph.parts.push("\n");
                    }
                    return;

                default:
                    return;
            }
        }

        function handleClose(name) {
            if (suppressDepth > 0) {
                suppressDepth -= 1;
                return;
            }

            switch (name) {
                case "t":
                    if (textDepth > 0) {
                        textDepth -= 1;
                    }
                    return;

                case "p":
                    flushParagraph();
                    return;

                case "tc":
                    closeCell();
                    return;

                case "tr":
                    closeRow();
                    return;

                case "tbl":
                    closeTable();
                    return;

                default:
                    return;
            }
        }

        function currentTable() {
            return tableStack.length
                ? tableStack[tableStack.length - 1]
                : null;
        }

        function flushParagraph() {
            if (!paragraph) {
                return;
            }

            var text = paragraph.parts.join("").replace(/[ \t]+$/, "");
            var rendered = renderParagraph(paragraph, text);

            paragraph = null;

            if (rendered === null) {
                return;
            }

            var table = currentTable();

            if (table && table.cell) {
                table.cell.push(rendered);
                return;
            }

            blocks.push(rendered);
        }

        function renderParagraph(source, text) {
            var trimmed = text.trim();

            var headingLevel = headingLevelFor(source.style);

            if (headingLevel > 0) {
                if (!trimmed) {
                    return null;
                }

                resetListCounters();

                return (
                    "\n" +
                    new Array(headingLevel + 1).join("#") +
                    " " +
                    trimmed +
                    "\n"
                );
            }

            var styleList = listStyleFor(source.style);

            if (source.numberingId !== null || styleList) {
                if (!trimmed) {
                    return null;
                }

                return renderListItem(source, trimmed, styleList);
            }

            resetListCounters();

            /*
             * An empty paragraph is a deliberate blank line in Word, and
             * it is what separates one requirement from the next. It is
             * kept, and collapsed later by the normaliser.
             */
            return trimmed ? trimmed : "";
        }

        function renderListItem(source, trimmed, styleList) {
            /*
             * A style-based list carries its level in the style name
             * ("ListBullet2"); a numPr-based one carries it in <w:ilvl>.
             */
            /* An explicit <w:numPr> always outranks the paragraph style. */
            var usesNumbering = source.numberingId !== null;

            var level = usesNumbering ? source.level : styleList.level;
            var indent = new Array(level + 1).join("  ");

            var format = usesNumbering
                ? numbering.formatFor(source.numberingId, source.level)
                : styleList.format;

            if (alreadyCarriesListMarker(trimmed)) {
                return indent + trimmed;
            }

            if (format === "bullet" || format === "none") {
                return indent + "- " + trimmed;
            }

            var counterKey = (usesNumbering ? source.numberingId : source.style) + ":" + level;

            listCounters[counterKey] = (listCounters[counterKey] || 0) + 1;

            /*
             * A deeper level restarting means the shallower counters
             * that follow it must start again too.
             */
            Object.keys(listCounters).forEach(function (key) {
                var parts = key.split(":");

                if (
                    parts[0] ===
                        String(usesNumbering ? source.numberingId : source.style) &&
                    Number(parts[1]) > level
                ) {
                    delete listCounters[key];
                }
            });

            return indent + listCounters[counterKey] + ". " + trimmed;
        }

        function resetListCounters() {
            listCounters = {};
        }

        function closeCell() {
            var table = currentTable();

            if (!table || !table.cell) {
                return;
            }

            flushParagraph();

            var cellText = table.cell
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();

            table.cell = null;

            if (table.row) {
                /* Pipes would break the Markdown row this becomes. */
                table.row.push(cellText.replace(/\|/g, "\\|"));
            }
        }

        function closeRow() {
            var table = currentTable();

            if (!table || !table.row) {
                return;
            }

            table.rows.push(table.row);
            table.row = null;
        }

        function closeTable() {
            var table = tableStack.pop();

            if (!table) {
                return;
            }

            var rendered = renderTable(table.rows);

            if (!rendered) {
                return;
            }

            var parent = currentTable();

            if (parent && parent.cell) {
                parent.cell.push(rendered);
                return;
            }

            blocks.push("\n" + rendered + "\n");
        }
    }

    function renderTable(rows) {
        var populated = rows.filter(function (row) {
            return row.some(function (cell) {
                return cell !== "";
            });
        });

        if (!populated.length) {
            return "";
        }

        var columnCount = populated.reduce(function (widest, row) {
            return Math.max(widest, row.length);
        }, 0);

        var lines = [];

        populated.forEach(function (row, index) {
            var cells = row.slice();

            while (cells.length < columnCount) {
                cells.push("");
            }

            lines.push("| " + cells.join(" | ") + " |");

            if (index === 0) {
                var separator = [];

                while (separator.length < columnCount) {
                    separator.push("---");
                }

                lines.push("| " + separator.join(" | ") + " |");
            }
        });

        return lines.join("\n");
    }

    /*
     * Word offers two ways to mark a list, and documents in the wild use
     * both — often in the same file. <w:numPr> is the modern one; the
     * built-in "ListBullet" / "ListNumber" / "ListParagraph" styles are
     * what most generated and template-derived documents carry, and they
     * frequently appear with no numbering reference at all. Recognising
     * only <w:numPr> silently flattens those lists into paragraphs,
     * which is exactly how an enumerated set of requirements stops
     * looking like a set of requirements.
     *
     * Deliberately excluded: "ListParagraph". Despite the name it is not
     * a list style — it is the generic indent Word applies to anything
     * pushed in one level, and documents use it constantly for
     * hand-numbered paragraphs that already read "1. Understand ...".
     * Treating it as a list turns those into "- 1. Understand ...".
     * A ListParagraph that really is a list carries <w:numPr>, which is
     * handled on its own path and takes precedence over this function.
     *
     * Returns null when the style is not a list style.
     */
    function listStyleFor(style) {
        if (!style) {
            return null;
        }

        var match = /^list(bullet|number)\s*-?\s*(\d)?$/i.exec(
            String(style).replace(/\s+/g, "")
        );

        if (!match) {
            return null;
        }

        return {
            format: /number/i.test(match[1]) ? "decimal" : "bullet",
            level: match[2] ? Math.max(0, parseInt(match[2], 10) - 1) : 0
        };
    }

    /*
     * Guards against emitting a marker in front of one the author typed
     * by hand. Matches "1.", "1)", "a.", "-", "*", "•" and friends.
     */
    function alreadyCarriesListMarker(text) {
        return /^\s*(?:[-*•◦▪·]|\(?[0-9]{1,3}[.)]|\(?[a-zA-Z][.)]|\(?[ivxIVX]{1,5}[.)])\s+/.test(
            text
        );
    }

    function headingLevelFor(style) {
        if (!style) {
            return 0;
        }

        /* "Heading1", "heading 1" and "berschrift1" all appear. */
        var match = /^(?:heading|berschrift|titre|kop)\s*-?\s*(\d)$/i.exec(
            String(style).replace(/\s+/g, "")
        );

        if (match) {
            return Math.min(6, parseInt(match[1], 10));
        }

        if (/^title$/i.test(style)) {
            return 1;
        }

        if (/^subtitle$/i.test(style)) {
            return 2;
        }

        return 0;
    }

    /* =========================================================
     * DOCX-03 — ENTRY POINT
     * ========================================================= */

    function parseDocx(bytes) {
        return Promise.resolve().then(function () {
            return parseDocxInternal(bytes);
        });
    }

    function parseDocxInternal(bytes) {
        var zip;

        try {
            zip = readZip(bytes);
        } catch (error) {
            /*
             * A legacy binary .doc renamed to .docx is the single most
             * common failure here, and it is worth naming explicitly
             * rather than reporting a generic ZIP error.
             */
            if (looksLikeLegacyDoc(bytes)) {
                throw attachmentError(
                    "legacy-doc",
                    "This is a legacy Word 97-2003 document. Please re-save it as .docx and attach it again."
                );
            }

            throw error;
        }

        if (!zip.entries["word/document.xml"]) {
            if (zip.entries["ppt/presentation.xml"]) {
                throw attachmentError(
                    "wrong-office-type",
                    "This is a PowerPoint file, not a Word document."
                );
            }

            if (zip.entries["xl/workbook.xml"]) {
                throw attachmentError(
                    "wrong-office-type",
                    "This is an Excel workbook, not a Word document."
                );
            }

            throw attachmentError(
                "docx-body-missing",
                "The Word document could not be read (word/document.xml is missing)."
            );
        }

        return Promise.all([
            readZipEntryText(zip, "word/document.xml"),
            readZipEntryText(zip, "word/numbering.xml")
        ]).then(function (results) {
            var documentXml = results[0];
            var numbering = parseNumbering(results[1]);

            var text = normaliseExtractedText(
                extractDocumentText(documentXml, numbering)
            );

            if (!text) {
                throw attachmentError(
                    "docx-empty",
                    "The Word document contains no readable text. If its content is images or screenshots, the text cannot be extracted."
                );
            }

            return { text: text, kind: "docx" };
        });
    }

    /* The OLE2 compound-file signature used by Word 97-2003. */
    function looksLikeLegacyDoc(bytes) {
        var signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
        var index = 0;

        if (bytes.length < signature.length) {
            return false;
        }

        while (index < signature.length) {
            if (bytes[index] !== signature[index]) {
                return false;
            }

            index += 1;
        }

        return true;
    }

    host.parseDocx = parseDocx;

    host.internals.docx = {
        parseNumbering: parseNumbering,
        extractDocumentText: extractDocumentText,
        headingLevelFor: headingLevelFor,
        renderTable: renderTable
    };
})(ScaAttachments);
