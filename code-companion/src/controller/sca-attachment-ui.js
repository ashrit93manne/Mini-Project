/*
 * Code Companion — Attachment UI
 *
 * Version 1.0.0
 *
 * Owns the composer's paperclip control, the attached-file tray, and the
 * plumbing that carries extracted text into the Form.io submission.
 *
 * Mounting strategy
 * -----------------
 * The paperclip, the tray and the file input are built here in script
 * rather than declared as Form.io components, and re-mounted whenever
 * they go missing. Form.io re-renders the form on almost every state
 * change and sanitises HTML element content, so a declarative <input
 * type="file"> is liable to be stripped or destroyed mid-conversation.
 * The two hidden fields that carry data to the backend ARE declared
 * components, because only declared components appear in the submission.
 *
 * Placement
 * ---------
 * The paperclip sits inside the left edge of the message box, opposite
 * the send button. That is the convention every current assistant UI
 * uses, and it reads correctly: the control belongs to the message being
 * composed, not to the page. Putting it in the header would have
 * detached it from the message it modifies; putting it beside Send would
 * have crowded the primary action and invited mis-clicks.
 */

var ScaAttachmentUi = (function buildScaAttachmentUi() {
    "use strict";

    var UI_VERSION = "1.0.0";

    var SELECTORS = {
        composer: ".formio-component-composer, .sca-composer",
        bar: "#sca-attachment-bar",
        tray: "#sca-attachment-tray",
        button: "#sca-attach-button",
        input: "#sca-attach-input",
        budgetHost: "#sca-prompt-budget",
        attachmentCounter: "#sca-attachment-counter"
    };

    var PAPERCLIP_ICON =
        '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" focusable="false">' +
        '<path fill="none" stroke="currentColor" stroke-width="1.9" ' +
        'stroke-linecap="round" stroke-linejoin="round" ' +
        'd="M21.44 11.05l-8.49 8.49a5.5 5.5 0 0 1-7.78-7.78l8.49-8.49a3.67 3.67 0 1 1 5.19 5.19l-8.5 8.49a1.83 1.83 0 0 1-2.6-2.6l7.85-7.84"/>' +
        "</svg>";

    var SPINNER_ICON =
        '<span class="sca-chip-spinner" aria-hidden="true"></span>';

    var controller = null;
    var engine = null;

    var state = {
        records: [],
        busy: 0,
        mounted: false,
        notice: ""
    };

    /* =========================================================
     * AUI-01 — LOGGING
     * ========================================================= */

    function log(level, event, details) {
        if (typeof window.__scaLog === "function") {
            window.__scaLog(level, "SCA-37", event, details);
            return;
        }

        if (level === "error" && window.console && window.console.error) {
            window.console.error("[SCA][SCA-37][" + event + "]", details || {});
        }
    }

    /* =========================================================
     * AUI-02 — MOUNTING
     * ========================================================= */

    function find(selector) {
        try {
            return document.querySelector(selector);
        } catch (error) {
            return null;
        }
    }

    function mount() {
        var composer = find(SELECTORS.composer);

        if (!composer) {
            return false;
        }

        if (find(SELECTORS.bar)) {
            state.mounted = true;
            return true;
        }

        var bar = document.createElement("div");

        bar.id = "sca-attachment-bar";
        bar.className = "sca-attachment-bar";

        var tray = document.createElement("div");

        tray.id = "sca-attachment-tray";
        tray.className = "sca-attachment-tray";
        tray.setAttribute("role", "list");
        tray.setAttribute("aria-label", "Attached files");

        var button = document.createElement("button");

        button.id = "sca-attach-button";
        button.type = "button";
        button.className = "sca-attach-button";
        button.innerHTML = PAPERCLIP_ICON;

        button.setAttribute("aria-label", attachButtonLabel());
        button.setAttribute("title", attachButtonLabel());

        var input = document.createElement("input");

        input.id = "sca-attach-input";
        input.className = "sca-attach-input";
        input.type = "file";
        input.multiple = true;
        input.tabIndex = -1;
        input.setAttribute("aria-hidden", "true");
        input.accept = engine.manager.acceptAttribute();

        input.addEventListener("change", function () {
            var files = Array.prototype.slice.call(input.files || []);

            /*
             * Resetting the value here means selecting the same file
             * twice in a row still fires a change event.
             */
            input.value = "";

            if (files.length) {
                addFiles(files);
            }
        });

        bar.appendChild(tray);
        bar.appendChild(button);
        bar.appendChild(input);

        composer.appendChild(bar);

        mountCounter();

        state.mounted = true;

        log("info", "attachment-bar-mounted", { version: UI_VERSION });

        renderTray();

        return true;
    }

    function attachButtonLabel() {
        return (
            "Attach a file (" +
            engine.manager
                .supportedExtensionList()
                .join(", ")
                .toUpperCase()
                .replace(/\./g, "") +
            ")"
        );
    }

    /*
     * The attachment counter lives beside the existing prompt-budget
     * readout so the developer sees one combined picture of how much of
     * the request they have used.
     */
    function mountCounter() {
        if (find(SELECTORS.attachmentCounter)) {
            return;
        }

        var host = find(SELECTORS.budgetHost);

        if (!host) {
            return;
        }

        var row = host.querySelector(".sca-prompt-budget-row");

        if (!row) {
            return;
        }

        var counter = document.createElement("span");

        counter.id = "sca-attachment-counter";
        counter.className = "sca-attachment-counter";
        counter.hidden = true;

        /*
         * A sibling of the character count, never a child of it: SCA-09b
         * rewrites that element's textContent on every keystroke, which
         * would delete a nested counter. Placing it immediately after
         * keeps the row reading as one continuous sentence.
         */
        var budgetText = row.querySelector("#sca-prompt-budget-text");

        if (budgetText && budgetText.nextSibling) {
            row.insertBefore(counter, budgetText.nextSibling);
        } else if (budgetText) {
            row.appendChild(counter);
        } else {
            row.insertBefore(counter, row.firstChild);
        }
    }

    /* =========================================================
     * AUI-03 — FILE INTAKE
     * ========================================================= */

    function addFiles(files) {
        var limits = engine.manager.LIMITS;
        var room = limits.MAX_FILES - state.records.length;

        if (room <= 0) {
            setNotice(
                "You can attach up to " + limits.MAX_FILES + " files per message."
            );

            return;
        }

        /*
         * Picking the same file twice is easy to do and silently spends
         * the budget twice, which can push a genuinely different file
         * into truncation. Name and size together are enough to catch it.
         */
        var duplicates = [];

        files = files.filter(function (file) {
            var isDuplicate = state.records.some(function (record) {
                return (
                    record.name === String(file.name || "") &&
                    record.bytes === (Number(file.size) || 0)
                );
            });

            if (isDuplicate) {
                duplicates.push(String(file.name || ""));
            }

            return !isDuplicate;
        });

        if (duplicates.length && !files.length) {
            setNotice(
                duplicates.length === 1
                    ? duplicates[0] + " is already attached."
                    : "Those files are already attached."
            );

            renderTray();

            return;
        }

        var accepted = files.slice(0, room);

        if (files.length > room) {
            setNotice(
                "Only the first " +
                    room +
                    " of " +
                    files.length +
                    " files were added — the limit is " +
                    limits.MAX_FILES +
                    " per message."
            );
        } else {
            setNotice("");
        }

        accepted.forEach(function (file) {
            var placeholder = {
                id:
                    "pending-" +
                    Date.now().toString(36) +
                    "-" +
                    Math.random().toString(36).slice(2, 8),
                name: String(file.name || "attachment"),
                bytes: Number(file.size) || 0,
                kind: null,
                text: "",
                characters: 0,
                truncated: false,
                error: null,
                status: "parsing"
            };

            state.records.push(placeholder);
            state.busy += 1;

            renderTray();
            refreshComposer();

            engine.manager
                .extractFile(file)
                .then(function (record) {
                    replaceRecord(placeholder.id, record);
                })
                .catch(function (error) {
                    placeholder.status = "error";
                    placeholder.error =
                        error && error.userMessage
                            ? error.userMessage
                            : "This file could not be read.";

                    log("error", "extraction-failed", {
                        fileName: placeholder.name,
                        message: placeholder.error
                    });
                })
                .then(function () {
                    state.busy = Math.max(0, state.busy - 1);

                    applyBudget();
                    renderTray();
                    refreshComposer();
                });
        });
    }

    function replaceRecord(placeholderId, record) {
        var index = indexOf(placeholderId);

        if (index === -1) {
            /* Removed while it was still parsing. */
            return;
        }

        record.status = record.error ? "error" : "ready";

        state.records[index] = record;

        log("info", record.error ? "file-rejected" : "file-extracted", {
            fileName: record.name,
            kind: record.kind,
            characters: record.characters,
            reason: record.error || undefined
        });
    }

    function indexOf(id) {
        var index = 0;

        while (index < state.records.length) {
            if (state.records[index].id === id) {
                return index;
            }

            index += 1;
        }

        return -1;
    }

    function removeRecord(id) {
        var index = indexOf(id);

        if (index === -1) {
            return;
        }

        var removed = state.records.splice(index, 1)[0];

        if (removed && removed.status === "parsing") {
            state.busy = Math.max(0, state.busy - 1);
        }

        setNotice("");
        applyBudget();
        renderTray();
        refreshComposer();

        log("info", "file-removed", { fileName: removed && removed.name });
    }

    /*
     * Re-run over the whole set whenever it changes: removing a large
     * file must give its budget back to a later one that was truncated
     * because of it.
     */
    function applyBudget() {
        var ready = state.records.filter(function (record) {
            return record.status === "ready";
        });

        ready.forEach(function (record) {
            if (record.originalText === undefined) {
                record.originalText = record.text;
            }

            record.text = record.originalText;
            record.characters = record.text.length;
            record.error = null;
        });

        engine.manager.applyBudget(ready);
    }

    /* =========================================================
     * AUI-04 — TRAY RENDERING
     * ========================================================= */

    function renderTray() {
        var tray = find(SELECTORS.tray);

        if (!tray) {
            return;
        }

        tray.innerHTML = "";

        state.records.forEach(function (record) {
            tray.appendChild(createChip(record));
        });

        if (state.notice) {
            tray.appendChild(createNoticeChip(state.notice));
        }

        var hasContent = state.records.length > 0 || Boolean(state.notice);

        tray.hidden = !hasContent;

        /*
         * The composer's height is driven by this attribute so the tray
         * has room without the message box or the send button moving.
         */
        if (document.body) {
            if (hasContent) {
                document.body.setAttribute("data-sca-attachments", "true");
            } else {
                document.body.removeAttribute("data-sca-attachments");
            }
        }

        renderCounter();
    }

    function createChip(record) {
        var chip = document.createElement("span");

        /*
         * A record can finish parsing cleanly and still be unusable —
         * the budget may have been spent by files ahead of it. The chip
         * follows whether the file will actually be sent, not whether
         * it parsed, so it never looks accepted while carrying a reason
         * it was left out.
         */
        var displayState = record.error ? "error" : record.status;

        chip.className = "sca-chip sca-chip-" + displayState;
        chip.setAttribute("role", "listitem");
        chip.setAttribute("data-attachment-id", record.id);

        var icon = document.createElement("span");

        icon.className = "sca-chip-icon";

        if (displayState === "parsing") {
            icon.innerHTML = SPINNER_ICON;
        } else {
            icon.textContent = kindBadge(record);
        }

        var label = document.createElement("span");

        label.className = "sca-chip-label";
        label.textContent = record.name;

        var detail = document.createElement("span");

        detail.className = "sca-chip-detail";
        detail.textContent = chipDetail(record);

        var remove = document.createElement("button");

        remove.type = "button";
        remove.className = "sca-chip-remove";
        remove.setAttribute("data-attachment-remove", record.id);
        remove.setAttribute("aria-label", "Remove " + record.name);
        remove.setAttribute("title", "Remove " + record.name);
        remove.textContent = "×";

        chip.appendChild(icon);
        chip.appendChild(label);
        chip.appendChild(detail);
        chip.appendChild(remove);

        if (record.error) {
            chip.setAttribute("title", record.name + " — " + record.error);
        } else if (displayState === "ready") {
            chip.setAttribute(
                "title",
                record.name + " — " + chipDetail(record)
            );
        }

        return chip;
    }

    function createNoticeChip(message) {
        var chip = document.createElement("span");

        chip.className = "sca-chip sca-chip-notice";
        chip.setAttribute("role", "listitem");
        chip.textContent = message;

        return chip;
    }

    function kindBadge(record) {
        if (record.error) {
            return "!";
        }

        if (record.kind === "pdf") {
            return "PDF";
        }

        if (record.kind === "docx") {
            return "DOC";
        }

        return "TXT";
    }

    function chipDetail(record) {
        if (record.status === "parsing" && !record.error) {
            return "reading…";
        }

        if (record.error) {
            return record.error;
        }

        var detail = record.characters.toLocaleString() + " chars";

        if (record.truncated) {
            detail += " · truncated";
        }

        return detail;
    }

    function renderCounter() {
        var counter = find(SELECTORS.attachmentCounter);

        if (!counter) {
            return;
        }

        var summary = engine.manager.summarise(
            state.records.filter(function (record) {
                return record.status === "ready";
            })
        );

        if (!summary.usableFiles) {
            counter.hidden = true;
            counter.textContent = "";
            return;
        }

        counter.hidden = false;

        counter.textContent =
            " · " +
            summary.usableFiles +
            (summary.usableFiles === 1 ? " file" : " files") +
            ", " +
            summary.characters.toLocaleString() +
            " chars attached" +
            (summary.truncated ? " (truncated)" : "");

        counter.classList.toggle("is-near-limit", summary.nearLimit);
        counter.classList.toggle("is-at-limit", summary.atLimit);
    }

    function setNotice(message) {
        state.notice = message || "";
    }

    /* =========================================================
     * AUI-05 — COMPOSER STATE
     * ========================================================= */

    function refreshComposer() {
        var button = find(SELECTORS.button);

        if (button) {
            var atFileLimit =
                state.records.length >= engine.manager.LIMITS.MAX_FILES;

            var blocked = isProcessing() || atFileLimit;

            button.disabled = blocked;
            button.setAttribute("aria-disabled", blocked ? "true" : "false");
            button.classList.toggle("is-busy", state.busy > 0);

            button.setAttribute(
                "title",
                atFileLimit
                    ? "Maximum of " +
                          engine.manager.LIMITS.MAX_FILES +
                          " files per message"
                    : attachButtonLabel()
            );
        }

        if (controller && typeof controller.updateSendAvailability === "function") {
            controller.updateSendAvailability();
        }
    }

    function isProcessing() {
        if (!controller) {
            return false;
        }

        if (controller.pending || controller.proceedInFlight) {
            return true;
        }

        var current =
            typeof controller.getCurrentState === "function"
                ? controller.getCurrentState()
                : null;

        var data = current && current.data ? current.data : {};

        return data.processing === true || data.processing === "true";
    }

    /* =========================================================
     * AUI-06 — SUBMISSION
     * ========================================================= */

    function readyRecords() {
        return state.records.filter(function (record) {
            return record.status === "ready" && !record.error && record.text;
        });
    }

    /*
     * Returns a reason string when the message must not be sent yet, or
     * null when it may proceed. Reasons are surfaced to the developer
     * rather than silently disabling Send.
     */
    function blockingReason(hasTypedMessage) {
        if (state.busy > 0) {
            return "Still reading the attached file — one moment.";
        }

        if (!hasTypedMessage && readyRecords().length > 0) {
            return (
                "Add a short instruction to go with the attachment — " +
                'for example "Build a RAP service from this specification".'
            );
        }

        return null;
    }

    /*
     * Writes the extracted text and the file metadata into the hidden
     * Form.io fields so they travel with the submission. Called from
     * beginSubmit, immediately before the form is posted.
     */
    function writeSubmissionFields() {
        if (!controller || typeof controller.setFormField !== "function") {
            return { block: "", metadata: [] };
        }

        var records = readyRecords();
        var block = engine.manager.buildAttachmentBlock(records);
        var metadata = engine.manager.toMetadata(records);

        controller.setFormField("attachmentsText", block);
        controller.setFormField("attachmentsJson", JSON.stringify(metadata));

        log("info", "attachments-submitted", {
            files: metadata.length,
            characters: block.length
        });

        return { block: block, metadata: metadata };
    }

    /* Called by New Chat: empties the tray and the hidden fields. */
    function clear() {
        clearVisualOnly();

        if (controller && typeof controller.setFormField === "function") {
            controller.setFormField("attachmentsText", "");
            controller.setFormField("attachmentsJson", "[]");
        }
    }

    /*
     * Called immediately after a send. The tray empties so the developer
     * sees the attachment has gone with the message, but the hidden
     * fields are left alone: the submission is still in flight and the
     * backend clears them in the state it returns.
     */
    function clearVisualOnly() {
        state.records = [];
        state.busy = 0;

        setNotice("");
        renderTray();
        refreshComposer();
    }

    /* Surfaces a short message in the tray, e.g. why Send did nothing. */
    function notify(message) {
        setNotice(message || "");
        renderTray();
    }

    /* =========================================================
     * AUI-07 — EVENTS
     *
     * Returns true when the event was an attachment interaction, so the
     * host controller's click handler can stop processing it.
     * ========================================================= */

    function handleClick(event) {
        var target =
            event && event.target instanceof Element ? event.target : null;

        if (!target) {
            return false;
        }

        var remove = target.closest("[data-attachment-remove]");

        if (remove) {
            event.preventDefault();
            event.stopPropagation();

            removeRecord(remove.getAttribute("data-attachment-remove"));

            return true;
        }

        var button = target.closest(SELECTORS.button);

        if (button) {
            event.preventDefault();
            event.stopPropagation();

            if (button.disabled) {
                return true;
            }

            var input = find(SELECTORS.input);

            if (input) {
                input.click();
            }

            return true;
        }

        return false;
    }

    /* =========================================================
     * AUI-08 — LIFECYCLE
     * ========================================================= */

    function init(hostController, attachmentEngine) {
        controller = hostController;
        engine = attachmentEngine;

        mount();
        refreshComposer();
    }

    /* Called from the host controller's periodic sync. */
    function sync() {
        if (!engine) {
            return;
        }

        if (!find(SELECTORS.bar)) {
            /* Form.io re-rendered the composer; put the control back. */
            state.mounted = false;
            mount();
        }

        mountCounter();
        refreshComposer();
    }

    return {
        version: UI_VERSION,
        init: init,
        sync: sync,
        mount: mount,
        clear: clear,
        clearVisualOnly: clearVisualOnly,
        notify: notify,
        handleClick: handleClick,
        addFiles: addFiles,
        removeRecord: removeRecord,
        readyRecords: readyRecords,
        blockingReason: blockingReason,
        writeSubmissionFields: writeSubmissionFields,
        isBusy: function () {
            return state.busy > 0;
        },
        count: function () {
            return readyRecords().length;
        },
        metadata: function () {
            return engine ? engine.manager.toMetadata(readyRecords()) : [];
        },
        /* Exposed for tests. */
        state: state
    };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = ScaAttachmentUi;
}
