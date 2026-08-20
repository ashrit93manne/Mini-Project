/*
 * Code Companion — Attachment Extraction Engine
 *
 * Component:
 * SAP Code Agent UI
 * → SAP Code Agent Chat
 * → Server-side JavaScript Component
 * → SAP Code Agent Controller javascript
 *
 * Version 1.0.0
 *
 * Purpose
 * -------
 * Reads a file the developer attached in the composer and returns the
 * text it contains, so the extracted content can be sent to the LLM as
 * grounding material alongside the typed requirement.
 *
 * Design constraints (these are deliberate, do not "simplify" them away)
 * ---------------------------------------------------------------------
 * 1. ZERO third-party dependencies.
 *    The application ships as a single .deptapp import. It cannot assume
 *    that a CDN is reachable, that a Content-Security-Policy allows an
 *    external <script>, or that the Node-RED runtime permits
 *    functionExternalModules. Everything here is written against
 *    platform APIs that are part of the browser itself.
 *
 * 2. ZIP inflation uses the native DecompressionStream API.
 *    DOCX is a ZIP container. DecompressionStream("deflate-raw") is
 *    available in every browser engine the platform supports, so no
 *    JavaScript inflate implementation is bundled.
 *
 * 3. NO DOMParser.
 *    Office XML is walked with a purpose-built tokenizer instead. This
 *    avoids namespace-resolution differences between engines and — more
 *    usefully — lets the whole module run under Node so the parsers can
 *    be regression-tested against real documents. See tests/.
 *
 * 4. Extraction is conservative.
 *    When a document cannot be read accurately (encrypted PDF, scanned
 *    PDF with no text layer, legacy binary .doc) the parser raises a
 *    specific, user-facing reason rather than returning partial noise.
 *    Silently handing the model a corrupted transcript is worse than
 *    telling the developer the file could not be read.
 */

var ScaAttachments = (function buildScaAttachments() {
    "use strict";

    var MODULE_VERSION = "1.0.0";

    /* =========================================================
     * ATT-01 — BINARY PRIMITIVES
     * ========================================================= */

    /*
     * PDF syntax is byte-oriented: offsets in the file refer to byte
     * positions, and binary stream payloads must not be mangled by a
     * UTF-8 decode. Everything structural is therefore done over a
     * latin1 ("binary") string, where one character is exactly one byte.
     */
    function bytesToLatin1(bytes) {
        var CHUNK = 0x8000;
        var parts = [];
        var index = 0;

        while (index < bytes.length) {
            parts.push(
                String.fromCharCode.apply(
                    null,
                    bytes.subarray(index, index + CHUNK)
                )
            );

            index += CHUNK;
        }

        return parts.join("");
    }

    function readUint16LE(bytes, offset) {
        return bytes[offset] | (bytes[offset + 1] << 8);
    }

    function readUint32LE(bytes, offset) {
        return (
            (bytes[offset] |
                (bytes[offset + 1] << 8) |
                (bytes[offset + 2] << 16) |
                (bytes[offset + 3] << 24)) >>>
            0
        );
    }

    /*
     * A UTF-8 decode that also strips a byte-order mark and normalises
     * line endings, so downstream character counts are stable across
     * files authored on Windows and on macOS/Linux.
     */
    function decodeUtf8(bytes) {
        var text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

        if (text.charCodeAt(0) === 0xfeff) {
            text = text.slice(1);
        }

        return text.replace(/\r\n?/g, "\n");
    }

    /* =========================================================
     * ATT-02 — NATIVE INFLATE
     *
     * "deflate-raw" is what ZIP entries store (no zlib wrapper).
     * "deflate" is what PDF /FlateDecode streams store (zlib wrapper).
     * ========================================================= */

    function inflate(bytes, format) {
        if (typeof DecompressionStream !== "function") {
            throw attachmentError(
                "unsupported-browser",
                "This browser cannot decompress the file. Please use a current " +
                    "version of Chrome, Edge, Firefox or Safari."
            );
        }

        var stream = new Blob([bytes])
            .stream()
            .pipeThrough(new DecompressionStream(format));

        return new Response(stream).arrayBuffer().then(function (buffer) {
            return new Uint8Array(buffer);
        });
    }

    /*
     * Some PDF producers write a /FlateDecode stream whose leading zlib
     * header is damaged or absent. Retrying as raw deflate recovers the
     * content instead of failing the whole document for one stream.
     */
    function inflateFlate(bytes) {
        return inflate(bytes, "deflate").catch(function () {
            return inflate(bytes, "deflate-raw").catch(function () {
                /*
                 * A leading garbage byte before the zlib header is the
                 * third failure mode seen in the wild.
                 */
                if (bytes.length > 1) {
                    return inflate(bytes.subarray(1), "deflate");
                }

                throw attachmentError(
                    "stream-decode-failed",
                    "A compressed section of the file could not be read."
                );
            });
        });
    }

    /* =========================================================
     * ATT-03 — ZIP CONTAINER READER
     *
     * Reads the central directory rather than scanning local headers,
     * because local headers may carry zeroed sizes when the entry was
     * written with a streaming data descriptor.
     * ========================================================= */

    function readZip(bytes) {
        var endOffset = findEndOfCentralDirectory(bytes);

        if (endOffset < 0) {
            throw attachmentError(
                "not-a-zip",
                "The file is not a valid Office document (its ZIP directory is missing)."
            );
        }

        var entryCount = readUint16LE(bytes, endOffset + 10);
        var directoryOffset = readUint32LE(bytes, endOffset + 16);

        /*
         * ZIP64: the classic 32-bit fields are saturated and the real
         * values live in the ZIP64 end-of-central-directory record.
         */
        if (directoryOffset === 0xffffffff || entryCount === 0xffff) {
            var zip64 = findZip64EndOfCentralDirectory(bytes, endOffset);

            if (zip64 >= 0) {
                entryCount = readUint32LE(bytes, zip64 + 32);
                directoryOffset = readUint32LE(bytes, zip64 + 48);
            }
        }

        var entries = {};
        var cursor = directoryOffset;
        var index = 0;

        while (index < entryCount && cursor + 46 <= bytes.length) {
            if (readUint32LE(bytes, cursor) !== 0x02014b50) {
                break;
            }

            var method = readUint16LE(bytes, cursor + 10);
            var compressedSize = readUint32LE(bytes, cursor + 20);
            var nameLength = readUint16LE(bytes, cursor + 28);
            var extraLength = readUint16LE(bytes, cursor + 30);
            var commentLength = readUint16LE(bytes, cursor + 32);
            var localOffset = readUint32LE(bytes, cursor + 42);

            var name = decodeUtf8(
                bytes.subarray(cursor + 46, cursor + 46 + nameLength)
            );

            entries[name] = {
                method: method,
                compressedSize: compressedSize,
                localOffset: localOffset
            };

            cursor += 46 + nameLength + extraLength + commentLength;
            index += 1;
        }

        return {
            bytes: bytes,
            entries: entries,
            names: Object.keys(entries)
        };
    }

    function findEndOfCentralDirectory(bytes) {
        /*
         * The record is at the very end unless a ZIP comment follows it,
         * and the comment length field is 16-bit — so 64 KB back is the
         * complete search space.
         */
        var limit = Math.max(0, bytes.length - 0xffff - 22);
        var offset = bytes.length - 22;

        while (offset >= limit) {
            if (readUint32LE(bytes, offset) === 0x06054b50) {
                return offset;
            }

            offset -= 1;
        }

        return -1;
    }

    function findZip64EndOfCentralDirectory(bytes, endOffset) {
        var offset = endOffset - 20;

        if (offset < 0 || readUint32LE(bytes, offset) !== 0x07064b50) {
            return -1;
        }

        var recordOffset = readUint32LE(bytes, offset + 8);

        if (
            recordOffset >= bytes.length ||
            readUint32LE(bytes, recordOffset) !== 0x06064b50
        ) {
            return -1;
        }

        return recordOffset;
    }

    function readZipEntry(zip, name) {
        var entry = zip.entries[name];

        if (!entry) {
            return Promise.resolve(null);
        }

        var bytes = zip.bytes;
        var localOffset = entry.localOffset;

        if (readUint32LE(bytes, localOffset) !== 0x04034b50) {
            return Promise.resolve(null);
        }

        /*
         * The local header repeats the name/extra lengths, and those are
         * the authoritative ones for locating the payload.
         */
        var nameLength = readUint16LE(bytes, localOffset + 26);
        var extraLength = readUint16LE(bytes, localOffset + 28);

        var dataStart = localOffset + 30 + nameLength + extraLength;
        var dataEnd = dataStart + entry.compressedSize;

        var payload = bytes.subarray(dataStart, dataEnd);

        if (entry.method === 0) {
            return Promise.resolve(payload);
        }

        if (entry.method !== 8) {
            return Promise.reject(
                attachmentError(
                    "unsupported-compression",
                    "The document uses an unsupported compression method."
                )
            );
        }

        return inflate(payload, "deflate-raw");
    }

    function readZipEntryText(zip, name) {
        return readZipEntry(zip, name).then(function (bytes) {
            return bytes ? decodeUtf8(bytes) : null;
        });
    }

    /* =========================================================
     * ATT-04 — XML TOKENIZER
     *
     * Office XML is regular enough that a tag-level scanner is both
     * sufficient and considerably more predictable than a DOM parse:
     * there is no namespace resolution to get wrong, and the callback
     * form keeps memory flat on large documents.
     * ========================================================= */

    var XML_ENTITIES = {
        amp: "&",
        lt: "<",
        gt: ">",
        quot: '"',
        apos: "'",
        nbsp: " "
    };

    function decodeXmlText(value) {
        if (value.indexOf("&") === -1) {
            return value;
        }

        return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (
            match,
            body
        ) {
            if (body.charAt(0) === "#") {
                var codePoint =
                    body.charAt(1) === "x" || body.charAt(1) === "X"
                        ? parseInt(body.slice(2), 16)
                        : parseInt(body.slice(1), 10);

                if (isFinite(codePoint) && codePoint > 0) {
                    try {
                        return String.fromCodePoint(codePoint);
                    } catch (error) {
                        return match;
                    }
                }

                return match;
            }

            return Object.prototype.hasOwnProperty.call(XML_ENTITIES, body)
                ? XML_ENTITIES[body]
                : match;
        });
    }

    function parseXmlAttributes(source) {
        var attributes = {};
        var pattern = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
        var match = pattern.exec(source);

        while (match) {
            attributes[match[1]] =
                decodeXmlText(match[3] !== undefined ? match[3] : match[4]);

            match = pattern.exec(source);
        }

        return attributes;
    }

    /*
     * Emits: { kind: "open" | "close" | "text", name, attributes, text }
     *
     * A self-closing tag emits an "open" immediately followed by a
     * "close", so consumers only ever implement two cases.
     */
    function walkXml(xml, visit) {
        var cursor = 0;
        var length = xml.length;

        while (cursor < length) {
            var open = xml.indexOf("<", cursor);

            if (open === -1) {
                emitText(xml.slice(cursor));
                return;
            }

            if (open > cursor) {
                emitText(xml.slice(cursor, open));
            }

            /* Comments, CDATA, processing instructions and doctypes. */
            if (xml.charAt(open + 1) === "!") {
                if (xml.substr(open, 4) === "<!--") {
                    cursor = advancePast(xml, open, "-->", 3);
                    continue;
                }

                if (xml.substr(open, 9) === "<![CDATA[") {
                    var cdataEnd = xml.indexOf("]]>", open);

                    if (cdataEnd === -1) {
                        visit({ kind: "text", text: xml.slice(open + 9) });
                        return;
                    }

                    visit({
                        kind: "text",
                        text: xml.slice(open + 9, cdataEnd)
                    });

                    cursor = cdataEnd + 3;
                    continue;
                }

                cursor = advancePast(xml, open, ">", 1);
                continue;
            }

            if (xml.charAt(open + 1) === "?") {
                cursor = advancePast(xml, open, "?>", 2);
                continue;
            }

            var close = findTagEnd(xml, open);

            if (close === -1) {
                return;
            }

            var raw = xml.slice(open + 1, close);

            cursor = close + 1;

            if (raw.charAt(0) === "/") {
                visit({ kind: "close", name: raw.slice(1).trim() });
                continue;
            }

            var selfClosing = raw.charAt(raw.length - 1) === "/";

            if (selfClosing) {
                raw = raw.slice(0, -1);
            }

            var nameEnd = raw.search(/[\s/>]/);
            var name = nameEnd === -1 ? raw : raw.slice(0, nameEnd);
            var attributeSource = nameEnd === -1 ? "" : raw.slice(nameEnd);

            visit({
                kind: "open",
                name: name,
                attributes:
                    attributeSource.indexOf("=") === -1
                        ? {}
                        : parseXmlAttributes(attributeSource)
            });

            if (selfClosing) {
                visit({ kind: "close", name: name });
            }
        }

        function emitText(text) {
            if (text) {
                visit({ kind: "text", text: decodeXmlText(text) });
            }
        }
    }

    function advancePast(xml, from, terminator, fallbackSkip) {
        var end = xml.indexOf(terminator, from + fallbackSkip);

        return end === -1 ? xml.length : end + terminator.length;
    }

    /*
     * Attribute values may legally contain ">", so the end of a tag is
     * the first ">" that is not inside a quoted value.
     */
    function findTagEnd(xml, start) {
        var quote = "";
        var index = start + 1;

        while (index < xml.length) {
            var character = xml.charAt(index);

            if (quote) {
                if (character === quote) {
                    quote = "";
                }
            } else if (character === '"' || character === "'") {
                quote = character;
            } else if (character === ">") {
                return index;
            }

            index += 1;
        }

        return -1;
    }

    /* =========================================================
     * ATT-05 — ERROR SHAPE
     * ========================================================= */

    function attachmentError(code, message) {
        var error = new Error(message);

        error.name = "AttachmentError";
        error.code = code;
        error.userMessage = message;

        return error;
    }

    /* =========================================================
     * ATT-06 — TEXT NORMALISATION
     * ========================================================= */

    function normaliseExtractedText(text) {
        return String(text || "")
            .replace(/\r\n?/g, "\n")
            /* Word and PDF both emit non-breaking and zero-width runs. */
            .replace(/ /g, " ")
            .replace(/[​-‍﻿]/g, "")
            /* Trailing spaces add nothing but consume prompt budget. */
            .replace(/[ \t]+\n/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
    }

    return {
        version: MODULE_VERSION,

        /* Exposed for the parsers in the sibling modules and for tests. */
        internals: {
            bytesToLatin1: bytesToLatin1,
            readUint16LE: readUint16LE,
            readUint32LE: readUint32LE,
            decodeUtf8: decodeUtf8,
            inflate: inflate,
            inflateFlate: inflateFlate,
            readZip: readZip,
            readZipEntry: readZipEntry,
            readZipEntryText: readZipEntryText,
            walkXml: walkXml,
            decodeXmlText: decodeXmlText,
            attachmentError: attachmentError,
            normaliseExtractedText: normaliseExtractedText
        }
    };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = ScaAttachments;
}
