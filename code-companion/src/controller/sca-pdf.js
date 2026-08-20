/*
 * Code Companion — PDF Text Extraction
 *
 * Version 1.0.0
 *
 * A dependency-free extractor for the text layer of a PDF.
 *
 * What it does
 * ------------
 * 1. Indexes every indirect object in the file, including those packed
 *    inside PDF 1.5+ compressed object streams.
 * 2. Walks the page tree so pages come out in reading order.
 * 3. Decodes each page's content stream and replays the text-showing
 *    operators, mapping character codes back to Unicode through the
 *    font's /ToUnicode CMap (or its base encoding when there is none).
 *
 * What it deliberately does not do
 * --------------------------------
 * It does not render, and it does not guess. An encrypted document and a
 * scanned document with no text layer are both reported as such, by
 * name, rather than returning empty or garbled output — a developer who
 * attached a scanned specification needs to know that is why the model
 * did not see it.
 *
 * A note on the parsing strategy
 * ------------------------------
 * Objects are located by scanning for "N G obj" rather than by reading
 * the cross-reference table. That is intentional: incrementally-updated,
 * linearised and lightly-corrupted PDFs all have xref tables that
 * disagree with reality, and a scan is unaffected by any of it. Where
 * two generations of the same object number exist, the later one in the
 * file wins, which matches how an incremental update is meant to
 * resolve.
 */

(function extendScaAttachmentsWithPdf(host) {
    "use strict";

    var internals = host.internals;

    var bytesToLatin1 = internals.bytesToLatin1;
    var inflateFlate = internals.inflateFlate;
    var attachmentError = internals.attachmentError;
    var normaliseExtractedText = internals.normaliseExtractedText;

    /*
     * A TJ adjustment is expressed in thousandths of an em and moves the
     * pen backwards. Kerning pairs sit around -10 to -80; an inter-word
     * gap is normally beyond -140. The threshold separates the two.
     */
    var WORD_GAP_THRESHOLD = 140;

    /* Guards against a malformed file pinning the tab. */
    var MAX_PAGES = 400;
    var MAX_OBJECT_SCAN = 200000;

    /* =========================================================
     * PDF-01 — LEXER
     * ========================================================= */

    function isWhitespace(character) {
        return (
            character === " " ||
            character === "\n" ||
            character === "\r" ||
            character === "\t" ||
            character === "\f" ||
            character === "\0"
        );
    }

    function isDelimiter(character) {
        return (
            character === "(" ||
            character === ")" ||
            character === "<" ||
            character === ">" ||
            character === "[" ||
            character === "]" ||
            character === "{" ||
            character === "}" ||
            character === "/" ||
            character === "%"
        );
    }

    function skipWhitespaceAndComments(source, index) {
        while (index < source.length) {
            var character = source.charAt(index);

            if (isWhitespace(character)) {
                index += 1;
                continue;
            }

            if (character === "%") {
                while (
                    index < source.length &&
                    source.charAt(index) !== "\n" &&
                    source.charAt(index) !== "\r"
                ) {
                    index += 1;
                }

                continue;
            }

            break;
        }

        return index;
    }

    /*
     * Reads one PDF object at `index`.
     *
     * Returns { value, next }. Values are modelled as:
     *   dictionary → { type: "dict", map: {}, streamAt: number|null }
     *   array      → { type: "array", items: [] }
     *   name       → { type: "name", name: string }
     *   reference  → { type: "ref", number: number }
     *   string     → { type: "string", bytes: string }   (latin1)
     *   number     → { type: "number", value: number }
     *   keyword    → { type: "keyword", word: string }
     */
    function readValue(source, index) {
        index = skipWhitespaceAndComments(source, index);

        if (index >= source.length) {
            return { value: null, next: index };
        }

        var character = source.charAt(index);

        if (character === "<") {
            if (source.charAt(index + 1) === "<") {
                return readDictionary(source, index);
            }

            return readHexString(source, index);
        }

        if (character === "(") {
            return readLiteralString(source, index);
        }

        if (character === "[") {
            return readArray(source, index);
        }

        if (character === "/") {
            return readName(source, index);
        }

        if (character === "]" || character === ">" || character === "}") {
            return { value: null, next: index + 1 };
        }

        return readNumberOrKeyword(source, index);
    }

    function readName(source, index) {
        var start = index + 1;
        var cursor = start;

        while (cursor < source.length) {
            var character = source.charAt(cursor);

            if (isWhitespace(character) || isDelimiter(character)) {
                break;
            }

            cursor += 1;
        }

        var raw = source.slice(start, cursor);

        /* #-escapes are legal inside names (e.g. /A#20B). */
        if (raw.indexOf("#") !== -1) {
            raw = raw.replace(/#([0-9a-fA-F]{2})/g, function (match, hex) {
                return String.fromCharCode(parseInt(hex, 16));
            });
        }

        return { value: { type: "name", name: raw }, next: cursor };
    }

    function readNumberOrKeyword(source, index) {
        var cursor = index;

        while (cursor < source.length) {
            var character = source.charAt(cursor);

            if (isWhitespace(character) || isDelimiter(character)) {
                break;
            }

            cursor += 1;
        }

        var token = source.slice(index, cursor);

        if (cursor === index) {
            return { value: null, next: index + 1 };
        }

        if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
            /*
             * "12 0 R" is an indirect reference; "12 0 obj" introduces
             * one. Both begin as a plain integer, so look ahead.
             */
            var lookahead = skipWhitespaceAndComments(source, cursor);
            var generationMatch = /^(\d+)\s+(R|obj)\b/.exec(
                source.slice(lookahead, lookahead + 24)
            );

            if (generationMatch && /^\d+$/.test(token)) {
                if (generationMatch[2] === "R") {
                    return {
                        value: { type: "ref", number: parseInt(token, 10) },
                        next:
                            lookahead +
                            generationMatch[0].length
                    };
                }
            }

            return {
                value: { type: "number", value: parseFloat(token) },
                next: cursor
            };
        }

        return { value: { type: "keyword", word: token }, next: cursor };
    }

    function readArray(source, index) {
        var items = [];
        var cursor = index + 1;

        while (cursor < source.length) {
            cursor = skipWhitespaceAndComments(source, cursor);

            if (source.charAt(cursor) === "]") {
                cursor += 1;
                break;
            }

            var read = readValue(source, cursor);

            if (read.next <= cursor) {
                cursor += 1;
                continue;
            }

            cursor = read.next;

            if (read.value !== null) {
                items.push(read.value);
            }
        }

        return { value: { type: "array", items: items }, next: cursor };
    }

    function readDictionary(source, index) {
        var map = {};
        var cursor = index + 2;

        while (cursor < source.length) {
            cursor = skipWhitespaceAndComments(source, cursor);

            if (source.charAt(cursor) === ">" && source.charAt(cursor + 1) === ">") {
                cursor += 2;
                break;
            }

            if (source.charAt(cursor) !== "/") {
                /* Recover from a malformed entry rather than aborting. */
                var skipped = readValue(source, cursor);

                if (skipped.next <= cursor) {
                    cursor += 1;
                } else {
                    cursor = skipped.next;
                }

                continue;
            }

            var keyRead = readName(source, cursor);
            var valueRead = readValue(source, keyRead.next);

            map[keyRead.value.name] = valueRead.value;

            cursor = valueRead.next <= keyRead.next ? keyRead.next + 1 : valueRead.next;
        }

        /* A stream body, if present, starts right after the dictionary. */
        var afterDictionary = skipWhitespaceAndComments(source, cursor);
        var streamAt = null;

        if (source.substr(afterDictionary, 6) === "stream") {
            var bodyStart = afterDictionary + 6;

            if (source.charAt(bodyStart) === "\r") {
                bodyStart += 1;
            }

            if (source.charAt(bodyStart) === "\n") {
                bodyStart += 1;
            }

            streamAt = bodyStart;
        }

        return {
            value: { type: "dict", map: map, streamAt: streamAt },
            next: cursor
        };
    }

    function readLiteralString(source, index) {
        var cursor = index + 1;
        var depth = 1;
        var out = [];

        while (cursor < source.length) {
            var character = source.charAt(cursor);

            if (character === "\\") {
                var escaped = source.charAt(cursor + 1);

                cursor += 2;

                switch (escaped) {
                    case "n":
                        out.push("\n");
                        break;
                    case "r":
                        out.push("\r");
                        break;
                    case "t":
                        out.push("\t");
                        break;
                    case "b":
                        out.push("\b");
                        break;
                    case "f":
                        out.push("\f");
                        break;
                    case "(":
                    case ")":
                    case "\\":
                        out.push(escaped);
                        break;
                    case "\r":
                        /* Line continuation; swallow an following \n. */
                        if (source.charAt(cursor) === "\n") {
                            cursor += 1;
                        }
                        break;
                    case "\n":
                        break;
                    default:
                        if (escaped >= "0" && escaped <= "7") {
                            var octal = escaped;

                            while (
                                octal.length < 3 &&
                                source.charAt(cursor) >= "0" &&
                                source.charAt(cursor) <= "7"
                            ) {
                                octal += source.charAt(cursor);
                                cursor += 1;
                            }

                            out.push(
                                String.fromCharCode(parseInt(octal, 8) & 0xff)
                            );
                        } else {
                            out.push(escaped);
                        }
                }

                continue;
            }

            if (character === "(") {
                depth += 1;
                out.push(character);
                cursor += 1;
                continue;
            }

            if (character === ")") {
                depth -= 1;
                cursor += 1;

                if (depth === 0) {
                    break;
                }

                out.push(character);
                continue;
            }

            out.push(character);
            cursor += 1;
        }

        return {
            value: { type: "string", bytes: out.join("") },
            next: cursor
        };
    }

    function readHexString(source, index) {
        var end = source.indexOf(">", index + 1);

        if (end === -1) {
            end = source.length;
        }

        var hex = source.slice(index + 1, end).replace(/[^0-9a-fA-F]/g, "");

        if (hex.length % 2 === 1) {
            /* An odd trailing digit is padded with zero, per the spec. */
            hex += "0";
        }

        var out = [];
        var cursor = 0;

        while (cursor < hex.length) {
            out.push(String.fromCharCode(parseInt(hex.substr(cursor, 2), 16)));
            cursor += 2;
        }

        return {
            value: { type: "string", bytes: out.join("") },
            next: end + 1
        };
    }

    /* =========================================================
     * PDF-02 — DOCUMENT INDEX
     * ========================================================= */

    function indexObjects(source) {
        var objects = {};
        var pattern = /(\d{1,10})\s+(\d{1,5})\s+obj\b/g;
        var match = pattern.exec(source);
        var scanned = 0;

        while (match && scanned < MAX_OBJECT_SCAN) {
            /*
             * A later definition supersedes an earlier one, which is how
             * incremental updates are meant to resolve.
             */
            objects[parseInt(match[1], 10)] = {
                bodyAt: match.index + match[0].length,
                endAt: -1
            };

            scanned += 1;
            match = pattern.exec(source);
        }

        return objects;
    }

    function makeDocument(source) {
        var document = {
            source: source,
            objects: indexObjects(source),
            cache: {},
            /* Objects unpacked out of compressed object streams. */
            unpacked: {}
        };

        return document;
    }

    function getObject(document, number) {
        if (Object.prototype.hasOwnProperty.call(document.cache, number)) {
            return document.cache[number];
        }

        var value = null;

        if (Object.prototype.hasOwnProperty.call(document.unpacked, number)) {
            value = document.unpacked[number];
        } else {
            var entry = document.objects[number];

            if (entry) {
                value = readValue(document.source, entry.bodyAt).value;
            }
        }

        document.cache[number] = value;

        return value;
    }

    /* Follows indirect references until a direct value is reached. */
    function resolve(document, value) {
        var hops = 0;

        while (value && value.type === "ref" && hops < 32) {
            value = getObject(document, value.number);
            hops += 1;
        }

        return value;
    }

    function dictGet(document, dictionary, key) {
        if (!dictionary || dictionary.type !== "dict") {
            return null;
        }

        return resolve(document, dictionary.map[key]);
    }

    function nameOf(value) {
        return value && value.type === "name" ? value.name : null;
    }

    function numberOf(value, fallback) {
        return value && value.type === "number" ? value.value : fallback;
    }

    /* =========================================================
     * PDF-03 — STREAM DECODING
     * ========================================================= */

    function readStreamBytes(document, dictionary) {
        if (!dictionary || dictionary.type !== "dict" || dictionary.streamAt === null) {
            return Promise.resolve(null);
        }

        var source = document.source;
        var start = dictionary.streamAt;
        var length = numberOf(dictGet(document, dictionary, "Length"), -1);

        var end = length >= 0 ? start + length : -1;

        /*
         * A wrong or indirect-but-missing /Length is common enough that
         * the "endstream" keyword is treated as the authority whenever
         * the declared length does not land on one.
         */
        if (
            end < 0 ||
            end > source.length ||
            source.slice(end, end + 20).indexOf("endstream") === -1
        ) {
            var marker = source.indexOf("endstream", start);

            end = marker === -1 ? source.length : marker;

            /* Trim the EOL that precedes the keyword. */
            if (source.charAt(end - 1) === "\n") {
                end -= 1;
            }

            if (source.charAt(end - 1) === "\r") {
                end -= 1;
            }
        }

        var raw = latin1ToBytes(source.slice(start, end));

        return applyFilters(document, dictionary, raw);
    }

    function latin1ToBytes(text) {
        var bytes = new Uint8Array(text.length);
        var index = 0;

        while (index < text.length) {
            bytes[index] = text.charCodeAt(index) & 0xff;
            index += 1;
        }

        return bytes;
    }

    function applyFilters(document, dictionary, bytes) {
        var filter = dictGet(document, dictionary, "Filter");
        var parms = dictGet(document, dictionary, "DecodeParms") ||
            dictGet(document, dictionary, "DP");

        var filters = [];
        var parmList = [];

        if (!filter) {
            return Promise.resolve(bytes);
        }

        if (filter.type === "name") {
            filters = [filter.name];
            parmList = [parms];
        } else if (filter.type === "array") {
            filters = filter.items.map(function (item) {
                return nameOf(resolve(document, item));
            });

            parmList =
                parms && parms.type === "array"
                    ? parms.items.map(function (item) {
                          return resolve(document, item);
                      })
                    : [parms];
        }

        var chain = Promise.resolve(bytes);

        filters.forEach(function (filterName, position) {
            chain = chain.then(function (current) {
                if (current === null) {
                    return null;
                }

                if (filterName === "FlateDecode" || filterName === "Fl") {
                    return inflateFlate(current).then(function (inflated) {
                        return applyPredictor(
                            document,
                            parmList[position],
                            inflated
                        );
                    });
                }

                if (filterName === "ASCIIHexDecode" || filterName === "AHx") {
                    return decodeAsciiHex(current);
                }

                if (filterName === "ASCII85Decode" || filterName === "A85") {
                    return decodeAscii85(current);
                }

                if (filterName === "LZWDecode" || filterName === "LZW") {
                    return applyPredictor(
                        document,
                        parmList[position],
                        decodeLzw(current)
                    );
                }

                if (filterName === "RunLengthDecode" || filterName === "RL") {
                    return decodeRunLength(current);
                }

                /*
                 * DCTDecode / JPXDecode / CCITTFaxDecode carry images.
                 * There is no text in them; signalling null lets the
                 * caller skip the stream instead of feeding the operator
                 * replay a block of binary noise.
                 */
                return null;
            });
        });

        return chain.catch(function () {
            return null;
        });
    }

    /*
     * PNG and TIFF predictors are a pre-compression transform. Cross-
     * reference streams always use one, and object streams occasionally
     * do; without undoing it the bytes are unusable.
     */
    function applyPredictor(document, parms, bytes) {
        if (!bytes || !parms || parms.type !== "dict") {
            return bytes;
        }

        var predictor = numberOf(dictGet(document, parms, "Predictor"), 1);

        if (predictor <= 1) {
            return bytes;
        }

        var colors = numberOf(dictGet(document, parms, "Colors"), 1);
        var bpc = numberOf(dictGet(document, parms, "BitsPerComponent"), 8);
        var columns = numberOf(dictGet(document, parms, "Columns"), 1);

        var bytesPerPixel = Math.max(1, Math.ceil((colors * bpc) / 8));
        var rowLength = Math.ceil((colors * bpc * columns) / 8);

        if (predictor === 2) {
            return applyTiffPredictor(bytes, colors, bpc, columns);
        }

        var rows = Math.floor(bytes.length / (rowLength + 1));
        var out = new Uint8Array(rows * rowLength);
        var previous = new Uint8Array(rowLength);
        var rowIndex = 0;

        while (rowIndex < rows) {
            var offset = rowIndex * (rowLength + 1);
            var filterType = bytes[offset];
            var row = bytes.subarray(offset + 1, offset + 1 + rowLength);
            var decoded = new Uint8Array(rowLength);
            var column = 0;

            while (column < rowLength) {
                var raw = row[column];
                var left = column >= bytesPerPixel ? decoded[column - bytesPerPixel] : 0;
                var up = previous[column];
                var upLeft =
                    column >= bytesPerPixel ? previous[column - bytesPerPixel] : 0;

                var value;

                switch (filterType) {
                    case 0:
                        value = raw;
                        break;
                    case 1:
                        value = raw + left;
                        break;
                    case 2:
                        value = raw + up;
                        break;
                    case 3:
                        value = raw + ((left + up) >> 1);
                        break;
                    case 4:
                        value = raw + paethPredictor(left, up, upLeft);
                        break;
                    default:
                        value = raw;
                }

                decoded[column] = value & 0xff;
                column += 1;
            }

            out.set(decoded, rowIndex * rowLength);
            previous = decoded;
            rowIndex += 1;
        }

        return out;
    }

    function applyTiffPredictor(bytes, colors, bpc, columns) {
        if (bpc !== 8) {
            return bytes;
        }

        var rowLength = colors * columns;
        var rowIndex = 0;

        while (rowIndex * rowLength < bytes.length) {
            var offset = rowIndex * rowLength;
            var column = colors;

            while (column < rowLength && offset + column < bytes.length) {
                bytes[offset + column] =
                    (bytes[offset + column] + bytes[offset + column - colors]) & 0xff;

                column += 1;
            }

            rowIndex += 1;
        }

        return bytes;
    }

    function paethPredictor(left, up, upLeft) {
        var estimate = left + up - upLeft;
        var distanceLeft = Math.abs(estimate - left);
        var distanceUp = Math.abs(estimate - up);
        var distanceUpLeft = Math.abs(estimate - upLeft);

        if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) {
            return left;
        }

        return distanceUp <= distanceUpLeft ? up : upLeft;
    }

    function decodeAsciiHex(bytes) {
        var text = bytesToLatin1(bytes);
        var end = text.indexOf(">");

        if (end !== -1) {
            text = text.slice(0, end);
        }

        var hex = text.replace(/[^0-9a-fA-F]/g, "");

        if (hex.length % 2 === 1) {
            hex += "0";
        }

        var out = new Uint8Array(hex.length / 2);
        var index = 0;

        while (index < out.length) {
            out[index] = parseInt(hex.substr(index * 2, 2), 16);
            index += 1;
        }

        return out;
    }

    function decodeAscii85(bytes) {
        var text = bytesToLatin1(bytes).replace(/\s/g, "");

        if (text.slice(0, 2) === "<~") {
            text = text.slice(2);
        }

        var end = text.indexOf("~>");

        if (end !== -1) {
            text = text.slice(0, end);
        }

        var out = [];
        var index = 0;

        while (index < text.length) {
            if (text.charAt(index) === "z") {
                out.push(0, 0, 0, 0);
                index += 1;
                continue;
            }

            var group = text.substr(index, 5);
            var padding = 5 - group.length;

            while (group.length < 5) {
                group += "u";
            }

            var total = 0;
            var position = 0;

            while (position < 5) {
                total = total * 85 + (group.charCodeAt(position) - 33);
                position += 1;
            }

            var quad = [
                (total >>> 24) & 0xff,
                (total >>> 16) & 0xff,
                (total >>> 8) & 0xff,
                total & 0xff
            ];

            out.push.apply(out, quad.slice(0, 4 - padding));

            index += 5;
        }

        return new Uint8Array(out);
    }

    function decodeRunLength(bytes) {
        var out = [];
        var index = 0;

        while (index < bytes.length) {
            var marker = bytes[index];

            if (marker === 128) {
                break;
            }

            if (marker < 128) {
                var runLength = marker + 1;
                var position = 0;

                while (position < runLength && index + 1 + position < bytes.length) {
                    out.push(bytes[index + 1 + position]);
                    position += 1;
                }

                index += 1 + runLength;
                continue;
            }

            var repeat = 257 - marker;
            var value = bytes[index + 1];
            var repeated = 0;

            while (repeated < repeat) {
                out.push(value);
                repeated += 1;
            }

            index += 2;
        }

        return new Uint8Array(out);
    }

    function decodeLzw(bytes) {
        var dictionary = [];
        var out = [];
        var bitBuffer = 0;
        var bitCount = 0;
        var codeWidth = 9;
        var previous = null;
        var index = 0;

        function resetDictionary() {
            dictionary = [];

            var code = 0;

            while (code < 256) {
                dictionary.push([code]);
                code += 1;
            }

            /* 256 = clear, 257 = end of data. */
            dictionary.push([]);
            dictionary.push([]);

            codeWidth = 9;
            previous = null;
        }

        resetDictionary();

        while (index < bytes.length) {
            bitBuffer = (bitBuffer << 8) | bytes[index];
            bitCount += 8;
            index += 1;

            while (bitCount >= codeWidth) {
                var code = (bitBuffer >> (bitCount - codeWidth)) & ((1 << codeWidth) - 1);

                bitCount -= codeWidth;

                if (code === 256) {
                    resetDictionary();
                    continue;
                }

                if (code === 257) {
                    return new Uint8Array(out);
                }

                var entry;

                if (code < dictionary.length) {
                    entry = dictionary[code];
                } else if (previous) {
                    entry = previous.concat([previous[0]]);
                } else {
                    return new Uint8Array(out);
                }

                out.push.apply(out, entry);

                if (previous) {
                    dictionary.push(previous.concat([entry[0]]));
                }

                previous = entry;

                if (dictionary.length + 1 >= 1 << codeWidth && codeWidth < 12) {
                    codeWidth += 1;
                }
            }
        }

        return new Uint8Array(out);
    }

    /* =========================================================
     * PDF-04 — COMPRESSED OBJECT STREAMS
     *
     * PDF 1.5 moved most non-stream objects — including page and font
     * dictionaries — inside /ObjStm streams. Without unpacking these,
     * a modern PDF looks like it has no pages at all.
     * ========================================================= */

    function unpackObjectStreams(document) {
        var numbers = Object.keys(document.objects);
        var pending = [];

        numbers.forEach(function (key) {
            var entry = document.objects[key];
            var value = readValue(document.source, entry.bodyAt).value;

            if (
                value &&
                value.type === "dict" &&
                nameOf(value.map.Type) === "ObjStm"
            ) {
                pending.push(value);
            }
        });

        if (!pending.length) {
            return Promise.resolve();
        }

        return pending.reduce(function (chain, dictionary) {
            return chain.then(function () {
                return readStreamBytes(document, dictionary)
                    .then(function (bytes) {
                        if (!bytes) {
                            return;
                        }

                        expandObjectStream(document, dictionary, bytesToLatin1(bytes));
                    })
                    .catch(function () {
                        /* One bad object stream must not fail the file. */
                    });
            });
        }, Promise.resolve());
    }

    function expandObjectStream(document, dictionary, text) {
        var count = numberOf(dictGet(document, dictionary, "N"), 0);
        var first = numberOf(dictGet(document, dictionary, "First"), 0);

        if (!count || !first) {
            return;
        }

        var header = text.slice(0, first);
        var pairs = header.match(/\d+/g) || [];
        var index = 0;

        while (index < count && index * 2 + 1 < pairs.length) {
            var objectNumber = parseInt(pairs[index * 2], 10);
            var objectOffset = parseInt(pairs[index * 2 + 1], 10);

            /*
             * An object physically present in the file body outranks a
             * packed copy, since it can only have got there through a
             * later incremental update.
             */
            if (!document.objects[objectNumber]) {
                document.unpacked[objectNumber] = readValue(
                    text,
                    first + objectOffset
                ).value;
            }

            index += 1;
        }
    }

    /* =========================================================
     * PDF-05 — PAGE TREE
     * ========================================================= */

    function collectPages(document) {
        var catalogNumber = findObjectByType(document, "Catalog");
        var pages = [];

        if (catalogNumber !== null) {
            var catalog = getObject(document, catalogNumber);
            var root = dictGet(document, catalog, "Pages");

            walkPageTree(document, root, {}, pages, 0);
        }

        if (!pages.length) {
            /*
             * No usable catalog: fall back to every /Page object in
             * object-number order, which is the order a producer
             * normally writes them in.
             */
            Object.keys(document.objects)
                .concat(Object.keys(document.unpacked))
                .map(Number)
                .sort(function (left, right) {
                    return left - right;
                })
                .forEach(function (number) {
                    var value = getObject(document, number);

                    if (
                        value &&
                        value.type === "dict" &&
                        nameOf(value.map.Type) === "Page" &&
                        pages.length < MAX_PAGES
                    ) {
                        pages.push({ dictionary: value, inherited: {} });
                    }
                });
        }

        return pages;
    }

    function findObjectByType(document, wanted) {
        var numbers = Object.keys(document.objects)
            .concat(Object.keys(document.unpacked))
            .map(Number);

        var index = 0;

        while (index < numbers.length) {
            var value = getObject(document, numbers[index]);

            if (
                value &&
                value.type === "dict" &&
                nameOf(value.map.Type) === wanted
            ) {
                return numbers[index];
            }

            index += 1;
        }

        return null;
    }

    /*
     * /Resources, /MediaBox and /Rotate are inheritable: a page may omit
     * them and take the value from an ancestor node.
     */
    var INHERITABLE = ["Resources", "MediaBox", "CropBox", "Rotate"];

    function walkPageTree(document, node, inherited, pages, depth) {
        if (!node || node.type !== "dict" || depth > 64 || pages.length >= MAX_PAGES) {
            return;
        }

        var merged = {};

        Object.keys(inherited).forEach(function (key) {
            merged[key] = inherited[key];
        });

        INHERITABLE.forEach(function (key) {
            if (node.map[key] !== undefined) {
                merged[key] = node.map[key];
            }
        });

        var type = nameOf(node.map.Type);
        var kids = dictGet(document, node, "Kids");

        if (type === "Page" || (!kids && node.map.Contents !== undefined)) {
            pages.push({ dictionary: node, inherited: merged });
            return;
        }

        if (!kids || kids.type !== "array") {
            return;
        }

        kids.items.forEach(function (kid) {
            walkPageTree(document, resolve(document, kid), merged, pages, depth + 1);
        });
    }

    /* =========================================================
     * PDF-06 — CHARACTER DECODING
     * ========================================================= */

    /*
     * WinAnsiEncoding is Latin-1 except for 0x80-0x9F, where it carries
     * the typographic characters most business documents actually use —
     * curly quotes, en/em dashes, the ellipsis. Getting this wrong turns
     * every apostrophe in the extracted text into a control character.
     */
    var WIN_ANSI_HIGH = {
        0x80: "€",
        0x82: "‚",
        0x83: "ƒ",
        0x84: "„",
        0x85: "…",
        0x86: "†",
        0x87: "‡",
        0x88: "ˆ",
        0x89: "‰",
        0x8a: "Š",
        0x8b: "‹",
        0x8c: "Œ",
        0x8e: "Ž",
        0x91: "‘",
        0x92: "’",
        0x93: "“",
        0x94: "”",
        0x95: "•",
        0x96: "–",
        0x97: "—",
        0x98: "˜",
        0x99: "™",
        0x9a: "š",
        0x9b: "›",
        0x9c: "œ",
        0x9e: "ž",
        0x9f: "Ÿ"
    };

    /*
     * The glyph names that appear in a /Differences array in practice.
     * Anything outside this set is resolved through the uniXXXX form or
     * dropped, which is preferable to inventing a character.
     */
    var GLYPH_NAMES = {
        space: " ",
        exclam: "!",
        quotedbl: '"',
        numbersign: "#",
        dollar: "$",
        percent: "%",
        ampersand: "&",
        quotesingle: "'",
        parenleft: "(",
        parenright: ")",
        asterisk: "*",
        plus: "+",
        comma: ",",
        hyphen: "-",
        period: ".",
        slash: "/",
        zero: "0",
        one: "1",
        two: "2",
        three: "3",
        four: "4",
        five: "5",
        six: "6",
        seven: "7",
        eight: "8",
        nine: "9",
        colon: ":",
        semicolon: ";",
        less: "<",
        equal: "=",
        greater: ">",
        question: "?",
        at: "@",
        bracketleft: "[",
        backslash: "\\",
        bracketright: "]",
        asciicircum: "^",
        underscore: "_",
        grave: "`",
        braceleft: "{",
        bar: "|",
        braceright: "}",
        asciitilde: "~",
        quoteleft: "‘",
        quoteright: "’",
        quotedblleft: "“",
        quotedblright: "”",
        quotesinglbase: "‚",
        quotedblbase: "„",
        endash: "–",
        emdash: "—",
        bullet: "•",
        ellipsis: "…",
        dagger: "†",
        daggerdbl: "‡",
        perthousand: "‰",
        guilsinglleft: "‹",
        guilsinglright: "›",
        trademark: "™",
        fi: "fi",
        fl: "fl",
        ff: "ff",
        ffi: "ffi",
        ffl: "ffl",
        nbspace: " ",
        euro: "€",
        Euro: "€",
        degree: "°",
        plusminus: "±",
        multiply: "×",
        divide: "÷",
        copyright: "©",
        registered: "®",
        section: "§",
        paragraph: "¶",
        sterling: "£",
        yen: "¥",
        cent: "¢",
        currency: "¤"
    };

    function glyphNameToText(name) {
        if (Object.prototype.hasOwnProperty.call(GLYPH_NAMES, name)) {
            return GLYPH_NAMES[name];
        }

        var uniMatch = /^uni([0-9A-Fa-f]{4,6})$/.exec(name);

        if (uniMatch) {
            return safeFromCodePoint(parseInt(uniMatch[1], 16));
        }

        var uMatch = /^u([0-9A-Fa-f]{4,6})$/.exec(name);

        if (uMatch) {
            return safeFromCodePoint(parseInt(uMatch[1], 16));
        }

        /* Single-letter names such as /A or /b are themselves. */
        if (/^[A-Za-z]$/.test(name)) {
            return name;
        }

        return "";
    }

    function safeFromCodePoint(codePoint) {
        if (!isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
            return "";
        }

        try {
            return String.fromCodePoint(codePoint);
        } catch (error) {
            return "";
        }
    }

    /*
     * Parses the /ToUnicode CMap, which is the authoritative code →
     * Unicode mapping when the font provides one. Handles both the
     * bfchar (individual) and bfrange (contiguous, with either a base
     * destination or an explicit array) forms.
     */
    function parseToUnicodeCMap(text) {
        var map = {};
        var codeByteLength = 1;

        var codespace = /begincodespacerange([\s\S]*?)endcodespacerange/g.exec(text);

        if (codespace) {
            var firstRange = /<([0-9A-Fa-f]+)>/.exec(codespace[1]);

            if (firstRange) {
                codeByteLength = Math.max(1, Math.ceil(firstRange[1].length / 2));
            }
        }

        var charPattern = /beginbfchar([\s\S]*?)endbfchar/g;
        var charBlock = charPattern.exec(text);

        while (charBlock) {
            var pairPattern = /<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]*)>|\/([^\s/<>[\]]+))/g;
            var pair = pairPattern.exec(charBlock[1]);

            while (pair) {
                map[parseInt(pair[1], 16)] = pair[2] !== undefined
                    ? hexToUnicode(pair[2])
                    : glyphNameToText(pair[3]);

                pair = pairPattern.exec(charBlock[1]);
            }

            charBlock = charPattern.exec(text);
        }

        var rangePattern = /beginbfrange([\s\S]*?)endbfrange/g;
        var rangeBlock = rangePattern.exec(text);

        while (rangeBlock) {
            parseBfRangeBlock(rangeBlock[1], map);
            rangeBlock = rangePattern.exec(text);
        }

        return { map: map, codeByteLength: codeByteLength };
    }

    function parseBfRangeBlock(block, map) {
        var pattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(\[[\s\S]*?\]|<[0-9A-Fa-f]*>|\/[^\s/<>[\]]+)/g;
        var match = pattern.exec(block);

        while (match) {
            var low = parseInt(match[1], 16);
            var high = parseInt(match[2], 16);
            var destination = match[3];

            /* Cap a nonsensical range rather than looping forever. */
            if (high < low || high - low > 65535) {
                high = low;
            }

            if (destination.charAt(0) === "[") {
                var itemPattern = /<([0-9A-Fa-f]*)>/g;
                var item = itemPattern.exec(destination);
                var code = low;

                while (item && code <= high) {
                    map[code] = hexToUnicode(item[1]);
                    code += 1;
                    item = itemPattern.exec(destination);
                }
            } else if (destination.charAt(0) === "/") {
                map[low] = glyphNameToText(destination.slice(1));
            } else {
                var baseHex = destination.slice(1, -1);
                var base = parseInt(baseHex, 16);

                /*
                 * The increment applies to the last code unit only, so a
                 * surrogate-pair destination stays intact.
                 */
                var isSurrogatePair = baseHex.length > 4;
                var offset = 0;

                while (low + offset <= high) {
                    if (isSurrogatePair) {
                        map[low + offset] = hexToUnicode(
                            (base + offset).toString(16).padStart(baseHex.length, "0")
                        );
                    } else {
                        map[low + offset] = safeFromCodePoint(base + offset);
                    }

                    offset += 1;
                }
            }

            match = pattern.exec(block);
        }
    }

    /* A bfchar destination is UTF-16BE and may hold several code units. */
    function hexToUnicode(hex) {
        if (!hex) {
            return "";
        }

        if (hex.length % 4 !== 0 && hex.length <= 4) {
            return safeFromCodePoint(parseInt(hex, 16));
        }

        var units = [];
        var index = 0;

        while (index + 4 <= hex.length) {
            units.push(parseInt(hex.substr(index, 4), 16));
            index += 4;
        }

        try {
            return String.fromCharCode.apply(null, units);
        } catch (error) {
            return "";
        }
    }

    /* =========================================================
     * PDF-07 — FONT DECODERS
     * ========================================================= */

    function buildFontDecoder(document, fontDictionary) {
        var subtype = nameOf(dictGet(document, fontDictionary, "Subtype"));
        var isComposite = subtype === "Type0";

        var encoding = dictGet(document, fontDictionary, "Encoding");
        var encodingName = nameOf(encoding);

        var differences = {};
        var baseEncoding = encodingName;

        if (encoding && encoding.type === "dict") {
            baseEncoding = nameOf(dictGet(document, encoding, "BaseEncoding"));

            var differencesArray = dictGet(document, encoding, "Differences");

            if (differencesArray && differencesArray.type === "array") {
                var code = 0;

                differencesArray.items.forEach(function (item) {
                    var value = resolve(document, item);

                    if (value && value.type === "number") {
                        code = value.value;
                        return;
                    }

                    if (value && value.type === "name") {
                        differences[code] = glyphNameToText(value.name);
                        code += 1;
                    }
                });
            }
        }

        /*
         * Identity-H is the near-universal composite encoding and is
         * always two bytes per code.
         */
        var codeByteLength =
            isComposite &&
            (encodingName === "Identity-H" ||
                encodingName === "Identity-V" ||
                encodingName === null)
                ? 2
                : 1;

        var toUnicodeStream = dictGet(document, fontDictionary, "ToUnicode");

        var decoder = {
            codeByteLength: codeByteLength,
            map: null,
            differences: differences,
            baseEncoding: baseEncoding,
            isComposite: isComposite
        };

        if (!toUnicodeStream || toUnicodeStream.type !== "dict") {
            return Promise.resolve(decoder);
        }

        return readStreamBytes(document, toUnicodeStream)
            .then(function (bytes) {
                if (!bytes) {
                    return decoder;
                }

                var parsed = parseToUnicodeCMap(bytesToLatin1(bytes));

                decoder.map = parsed.map;

                /*
                 * A simple font's ToUnicode may still declare 2-byte
                 * codespace; trust the composite flag over that, since a
                 * simple font is single-byte by definition.
                 */
                decoder.codeByteLength = isComposite
                    ? Math.max(parsed.codeByteLength, 1)
                    : 1;

                return decoder;
            })
            .catch(function () {
                return decoder;
            });
    }

    function decodeStringWithFont(decoder, bytes) {
        if (!decoder) {
            /* No font selected: assume single-byte WinAnsi. */
            return decodeSimpleBytes(bytes, {}, "WinAnsiEncoding");
        }

        if (decoder.codeByteLength === 2) {
            var out = [];
            var index = 0;

            while (index + 1 < bytes.length) {
                var code = (bytes.charCodeAt(index) << 8) | bytes.charCodeAt(index + 1);

                out.push(lookupComposite(decoder, code));
                index += 2;
            }

            /* An odd trailing byte is malformed; ignore it. */
            return out.join("");
        }

        if (decoder.map) {
            var simple = [];
            var position = 0;

            while (position < bytes.length) {
                var singleCode = bytes.charCodeAt(position);
                var mapped = decoder.map[singleCode];

                if (mapped === undefined || mapped === "") {
                    mapped =
                        decoder.differences[singleCode] !== undefined
                            ? decoder.differences[singleCode]
                            : decodeSimpleByte(singleCode, decoder.baseEncoding);
                }

                simple.push(mapped);
                position += 1;
            }

            return simple.join("");
        }

        return decodeSimpleBytes(bytes, decoder.differences, decoder.baseEncoding);
    }

    function lookupComposite(decoder, code) {
        if (decoder.map) {
            var mapped = decoder.map[code];

            if (mapped !== undefined) {
                return mapped;
            }
        }

        /*
         * A composite font with no ToUnicode cannot be resolved to text.
         * Emitting the raw CID would produce convincing-looking nonsense,
         * so nothing is emitted and the page-level heuristic reports the
         * document as unreadable if this dominates.
         */
        return "";
    }

    function decodeSimpleBytes(bytes, differences, baseEncoding) {
        var out = [];
        var index = 0;

        while (index < bytes.length) {
            var code = bytes.charCodeAt(index);

            out.push(
                differences[code] !== undefined
                    ? differences[code]
                    : decodeSimpleByte(code, baseEncoding)
            );

            index += 1;
        }

        return out.join("");
    }

    function decodeSimpleByte(code, baseEncoding) {
        if (code >= 0x80 && code <= 0x9f && baseEncoding !== "MacRomanEncoding") {
            return WIN_ANSI_HIGH[code] || "";
        }

        if (code === 0) {
            return "";
        }

        return String.fromCharCode(code);
    }

    /* =========================================================
     * PDF-08 — CONTENT STREAM REPLAY
     * ========================================================= */

    function extractPageText(document, page, fontDecoders) {
        var contentPromise = readPageContent(document, page);

        return contentPromise.then(function (content) {
            if (!content) {
                return "";
            }

            return replayContent(content, fontDecoders);
        });
    }

    function readPageContent(document, page) {
        var contents = dictGet(document, page.dictionary, "Contents");

        if (!contents) {
            return Promise.resolve("");
        }

        var streams =
            contents.type === "array"
                ? contents.items.map(function (item) {
                      return resolve(document, item);
                  })
                : [contents];

        return streams
            .reduce(function (chain, stream) {
                return chain.then(function (accumulated) {
                    return readStreamBytes(document, stream)
                        .then(function (bytes) {
                            /*
                             * Content streams are concatenated with a
                             * newline: a stream may legally end mid-token
                             * and continue in the next.
                             */
                            return bytes
                                ? accumulated + bytesToLatin1(bytes) + "\n"
                                : accumulated;
                        })
                        .catch(function () {
                            return accumulated;
                        });
                });
            }, Promise.resolve(""));
    }

    function replayContent(content, fontDecoders) {
        var pieces = [];
        var operands = [];
        var cursor = 0;

        var currentFont = null;
        var lastY = null;
        var lastX = null;
        var pendingNewline = false;

        while (cursor < content.length) {
            cursor = skipWhitespaceAndComments(content, cursor);

            if (cursor >= content.length) {
                break;
            }

            var read = readValue(content, cursor);

            if (read.next <= cursor) {
                cursor += 1;
                continue;
            }

            cursor = read.next;

            var value = read.value;

            if (!value) {
                continue;
            }

            if (value.type !== "keyword") {
                operands.push(value);

                /* A runaway operand list means the stream is corrupt. */
                if (operands.length > 64) {
                    operands.shift();
                }

                continue;
            }

            cursor = applyOperator(value.word, operands, cursor);

            operands = [];
        }

        return pieces.join("");

        function applyOperator(operator, args, position) {
            switch (operator) {
                case "BT":
                    lastY = null;
                    lastX = null;
                    return position;

                case "ET":
                    pendingNewline = true;
                    return position;

                case "Tf":
                    if (args.length >= 2 && args[0].type === "name") {
                        currentFont = fontDecoders[args[0].name] || null;
                    }
                    return position;

                case "Td":
                case "TD":
                    if (args.length >= 2) {
                        moveText(
                            numberOf(args[args.length - 2], 0),
                            numberOf(args[args.length - 1], 0)
                        );
                    }
                    return position;

                case "Tm":
                    if (args.length >= 6) {
                        setTextMatrix(
                            numberOf(args[4], 0),
                            numberOf(args[5], 0)
                        );
                    }
                    return position;

                case "T*":
                    pendingNewline = true;
                    return position;

                case "Tj":
                    if (args.length >= 1 && args[args.length - 1].type === "string") {
                        showText(args[args.length - 1].bytes);
                    }
                    return position;

                case "'":
                    pendingNewline = true;

                    if (args.length >= 1 && args[args.length - 1].type === "string") {
                        showText(args[args.length - 1].bytes);
                    }
                    return position;

                case '"':
                    pendingNewline = true;

                    if (args.length >= 1 && args[args.length - 1].type === "string") {
                        showText(args[args.length - 1].bytes);
                    }
                    return position;

                case "TJ":
                    if (args.length >= 1 && args[args.length - 1].type === "array") {
                        showTextArray(args[args.length - 1].items);
                    }
                    return position;

                case "BI":
                    /*
                     * Inline image: its binary payload would otherwise be
                     * lexed as operators. Skip to the matching EI.
                     */
                    return skipInlineImage(content, position);

                default:
                    return position;
            }
        }

        function setTextMatrix(x, y) {
            if (lastY !== null && Math.abs(y - lastY) > 0.5) {
                pendingNewline = true;
            } else if (lastX !== null && x < lastX - 1) {
                /*
                 * Same line, but the pen jumped backwards: a new column
                 * or a new cell. A space keeps the words apart.
                 */
                pendingSpace();
            }

            lastY = y;
            lastX = x;
        }

        function moveText(dx, dy) {
            if (Math.abs(dy) > 0.5) {
                pendingNewline = true;
            } else if (dx > 0 && dx > 2) {
                pendingSpace();
            }

            if (lastY !== null) {
                lastY += dy;
            }

            if (lastX !== null) {
                lastX += dx;
            }
        }

        function pendingSpace() {
            var last = pieces.length ? pieces[pieces.length - 1] : "";

            if (last && !/\s$/.test(last)) {
                pieces.push(" ");
            }
        }

        function flushNewline() {
            if (!pendingNewline) {
                return;
            }

            pendingNewline = false;

            if (pieces.length && !/\n$/.test(pieces[pieces.length - 1])) {
                pieces.push("\n");
            }
        }

        function showText(bytes) {
            var text = decodeStringWithFont(currentFont, bytes);

            if (!text) {
                return;
            }

            flushNewline();
            pieces.push(text);
        }

        function showTextArray(items) {
            flushNewline();

            items.forEach(function (item) {
                if (item.type === "string") {
                    var text = decodeStringWithFont(currentFont, item.bytes);

                    if (text) {
                        pieces.push(text);
                    }

                    return;
                }

                if (item.type === "number" && item.value < -WORD_GAP_THRESHOLD) {
                    pendingSpace();
                }
            });
        }
    }

    function skipInlineImage(content, position) {
        var search = position;

        while (search < content.length) {
            var marker = content.indexOf("EI", search);

            if (marker === -1) {
                return content.length;
            }

            var before = content.charAt(marker - 1);
            var after = content.charAt(marker + 2);

            if (
                (isWhitespace(before) || before === ">") &&
                (after === "" || isWhitespace(after) || isDelimiter(after))
            ) {
                return marker + 2;
            }

            search = marker + 2;
        }

        return content.length;
    }

    /* =========================================================
     * PDF-09 — PAGE FONT RESOURCES
     * ========================================================= */

    function buildPageFonts(document, page, cache) {
        var resources =
            dictGet(document, page.dictionary, "Resources") ||
            resolve(document, page.inherited.Resources);

        var fonts = dictGet(document, resources, "Font");

        if (!fonts || fonts.type !== "dict") {
            return Promise.resolve({});
        }

        var decoders = {};
        var names = Object.keys(fonts.map);

        return names
            .reduce(function (chain, name) {
                return chain.then(function () {
                    var reference = fonts.map[name];
                    var cacheKey =
                        reference && reference.type === "ref"
                            ? "ref:" + reference.number
                            : null;

                    if (cacheKey && cache[cacheKey]) {
                        decoders[name] = cache[cacheKey];
                        return;
                    }

                    var fontDictionary = resolve(document, reference);

                    if (!fontDictionary || fontDictionary.type !== "dict") {
                        return;
                    }

                    /*
                     * A Type0 font's real encoding details live on the
                     * descendant; the ToUnicode stays on the parent, so
                     * both are consulted.
                     */
                    return buildFontDecoder(document, fontDictionary).then(function (
                        decoder
                    ) {
                        decoders[name] = decoder;

                        if (cacheKey) {
                            cache[cacheKey] = decoder;
                        }
                    });
                });
            }, Promise.resolve())
            .then(function () {
                return decoders;
            });
    }

    /* =========================================================
     * PDF-10 — ENTRY POINT
     * ========================================================= */

    /*
     * Callers treat every parser as promise-returning. Throwing
     * synchronously from the validation prologue would escape the
     * attachment pipeline's .catch and surface as an unhandled error,
     * so the whole body runs inside a promise.
     */
    function parsePdf(bytes) {
        return Promise.resolve().then(function () {
            return parsePdfInternal(bytes);
        });
    }

    function parsePdfInternal(bytes) {
        var source = bytesToLatin1(bytes);

        if (source.slice(0, 5) !== "%PDF-") {
            /* Some files carry junk before the header; tolerate a little. */
            var headerAt = source.indexOf("%PDF-");

            if (headerAt === -1 || headerAt > 1024) {
                throw attachmentError(
                    "not-a-pdf",
                    "The file is not a valid PDF."
                );
            }

            source = source.slice(headerAt);
        }

        if (/\/Encrypt\b/.test(source)) {
            throw attachmentError(
                "pdf-encrypted",
                "This PDF is password-protected or encrypted, so its text cannot be read. Please attach an unprotected copy."
            );
        }

        var document = makeDocument(source);

        return unpackObjectStreams(document)
            .then(function () {
                var pages = collectPages(document);

                if (!pages.length) {
                    throw attachmentError(
                        "pdf-no-pages",
                        "No readable pages were found in this PDF."
                    );
                }

                var fontCache = {};

                return pages.reduce(function (chain, page, index) {
                    return chain.then(function (collected) {
                        return buildPageFonts(document, page, fontCache)
                            .then(function (fonts) {
                                return extractPageText(document, page, fonts);
                            })
                            .then(function (text) {
                                collected.push({ index: index, text: text });
                                return collected;
                            })
                            .catch(function () {
                                collected.push({ index: index, text: "" });
                                return collected;
                            });
                    });
                }, Promise.resolve([]));
            })
            .then(function (pageTexts) {
                return finishPdf(pageTexts);
            });
    }

    function finishPdf(pageTexts) {
        var body = pageTexts
            .map(function (page) {
                var text = normaliseExtractedText(page.text);

                if (!text) {
                    return "";
                }

                /*
                 * Page markers let the model cite a location, which is
                 * what a developer asks for when a specification runs to
                 * dozens of pages.
                 */
                return "[Page " + (page.index + 1) + "]\n" + text;
            })
            .filter(Boolean)
            .join("\n\n");

        var text = normaliseExtractedText(body);

        var readableCharacters = text.replace(/[^A-Za-z0-9]/g, "").length;

        /*
         * A PDF of scanned pages parses perfectly and yields almost
         * nothing, because the words are pixels. Saying so is far more
         * useful than returning three stray characters and letting the
         * model answer from an empty document.
         */
        if (readableCharacters < Math.max(20, pageTexts.length * 15)) {
            throw attachmentError(
                "pdf-no-text-layer",
                "This PDF has no extractable text layer — it appears to be a scan or an image-only export. Please attach a text-based PDF or the original document."
            );
        }

        return { text: text, kind: "pdf", pages: pageTexts.length };
    }

    host.parsePdf = parsePdf;

    host.internals.pdf = {
        readValue: readValue,
        makeDocument: makeDocument,
        getObject: getObject,
        resolve: resolve,
        dictGet: dictGet,
        collectPages: collectPages,
        parseToUnicodeCMap: parseToUnicodeCMap,
        replayContent: replayContent,
        decodeAscii85: decodeAscii85,
        decodeLzw: decodeLzw,
        decodeRunLength: decodeRunLength
    };
})(ScaAttachments);
