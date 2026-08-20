/*
 * Diagnostic: print the text the attachment engine extracts from a file.
 *
 *   node tools/extract.js path/to/Specification.docx
 *   node tools/extract.js path/to/Requirements.pdf --stats
 *
 * Useful when a document does not come through the way it should: this
 * runs the exact browser parsers under Node and shows their output, so a
 * problem can be diagnosed without opening the application.
 */

const fs = require("fs");
const path = require("path");

global.ScaAttachments = require("../src/controller/sca-attachments.js");
require("../src/controller/sca-docx.js");
require("../src/controller/sca-pdf.js");
require("../src/controller/sca-attachment-manager.js");

const target = process.argv[2];
const statsOnly = process.argv.includes("--stats");

if (!target) {
    console.error("usage: node tools/extract.js <file> [--stats]");
    process.exit(2);
}

const manager = ScaAttachments.manager;
const type = manager.typeFor(target);

if (!type) {
    console.error(
        "unsupported file type — supported: " +
            manager.supportedExtensionList().join(", ")
    );
    process.exit(2);
}

const bytes = new Uint8Array(fs.readFileSync(target));

type.parse(bytes)
    .then((result) => {
        const tokens = Math.ceil(
            result.text.length / manager.LIMITS.APPROXIMATE_CHARACTERS_PER_TOKEN
        );

        console.error(
            [
                path.basename(target),
                type.label,
                result.pages ? result.pages + " pages" : null,
                result.text.length.toLocaleString() + " chars",
                "~" + tokens.toLocaleString() + " tokens",
                result.text.length > manager.LIMITS.MAX_ATTACHMENT_CHARACTERS
                    ? "OVER BUDGET — would be truncated"
                    : "fits the attachment budget"
            ]
                .filter(Boolean)
                .join(" · ")
        );

        if (!statsOnly) {
            console.log(result.text);
        }
    })
    .catch((error) => {
        console.error("could not read: " + (error.userMessage || error.message));
        process.exit(1);
    });
