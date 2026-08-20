/*
 * Code Companion — Attachment UI
 *
 * Version 2.0.0
 *
 * Owns the attached-file tray and the plumbing that carries extracted
 * text into the Form.io submission.
 *
 * Why this is v2 (read before changing the mounting strategy again)
 * -------------------------------------------------------------------
 * v1 built the file-picker trigger — a <button> plus a synthesized
 * <input type="file"> — entirely in script and appended it into the DOM
 * via querySelector + appendChild. It worked in every harness tested
 * against, including a browser loading the exact built export, and it
 * did not appear at all in the real deployment. The one thing that DID
 * keep working there was the hamburger removal (SCA-36), which proved
 * the script executes fine; the difference is that SCA-36 only ever
 * TAGS elements the platform already rendered, while v1's file picker
 * MANUFACTURED new elements and positioned them with CSS calc() against
 * assumptions about the composer's exact real DOM. One of those
 * assumptions didn't hold, and the result was silent — nothing to click,
 * nothing visibly broken either.
 *
 * v2 removes that entire class of risk for the picker itself: the file
 * input is now a DECLARED Form.io `file` component (key: attachmentPicker,
 * added in build_deptapp.py), rendered by Form.io the same way the send
 * button, the message textarea and every other proven-working control on
 * this screen are rendered. This script never creates it and never
 * positions it by calculation — it only listens for a native `change`
 * event bubbling up from the real <input type="file"> that component
 * contains, exactly the way SCA-24's click handling already listens for
 * clicks on the Send button. That delegation pattern is known to work in
 * production, because Send and New Chat already depend on it.
 *
 * The attachment tray (the chip list) still needs a place to render
 * rich, changing content — spinners, character counts, remove buttons —
 * that a plain Form.io field can't express. For that this script keeps
 * doing what the base controller has always done for the chat log and
 * the header: write innerHTML into a DECLARED `htmlelement` component
 * (key: attachmentTrayHost). The container's existence is guaranteed by
 * Form.io; only what fills it is script-owned, matching #sca-chat-log
 * exactly.
 *
 * If a chip's "remove" affordance or the counter beside the prompt
 * budget doesn't render pixel-perfect on some unforeseen layout, the
 * degraded form is still a working, if plainer, Form.io file field —
 * never nothing.
 */

var ScaAttachmentUi = (function buildScaAttachmentUi() {
    "use strict";

    var UI_VERSION = "2.0.0";

    var SELECTORS = {
        pickerRoot: ".formio-component-attachmentPicker",
        pickerInput: '.formio-component-attachmentPicker input[type="file"]',
        trayHost: "#sca-attachment-tray",
        budgetHost: "#sca-prompt-budget",
        attachmentCounter: "#sca-attachment-counter"
    };

    var SPINNER_ICON =
        '<span class="sca-chip-spinner" aria-hidden="true"></span>';

    var controller = null;
    var engine = null;

    var state = {
        records: [],
        busy: 0,
        notice: "",
        /*
         * Guards against attaching the delegated change listener more
         * than once across repeated mount() calls.
         */
        listenerAttached: false
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
     *
     * "Mounting" here means: find the components Form.io already
     * rendered, and make sure our one delegated listener is attached.
     * Nothing is created.
     * ========================================================= */

    function find(selector) {
        try {
            return document.querySelector(selector);
        } catch (error) {
            return null;
        }
    }

    function mount() {
        var pickerRoot = find(SELECTORS.pickerRoot);
        var trayHost = find(SELECTORS.trayHost);

        attachChangeListener();
        mountCounter();

        if (pickerRoot) {
            decoratePicker(pickerRoot);
        }

        renderTray();

        return Boolean(pickerRoot) && Boolean(trayHost);
    }

    /*
     * Attached once, to `document`, and never removed for the life of
     * the page — the same lifetime as SCA-31's click/keydown listeners.
     * Delegation means it keeps working across every Form.io re-render
     * without needing to be re-attached to a fresh element each time.
     */
    function attachChangeListener() {
        if (state.listenerAttached) {
            return;
        }

        document.addEventListener(
            "change",
            function (event) {
                var input =
                    event.target instanceof Element
                        ? event.target.closest(SELECTORS.pickerInput)
                        : null;

                if (!input) {
                    return;
                }

                var files = Array.prototype.slice.call(input.files || []);

                if (files.length) {
                    addFiles(files);
                }

                /*
                 * Form.io owns this input's value; clearing it here would
                 * fight its own state management. Duplicate detection in
                 * addFiles() is what makes re-picking the same file safe,
                 * not clearing the input.
                 */
            },
            true
        );

        state.listenerAttached = true;

        log("info", "change-listener-attached", { version: UI_VERSION });
    }

    /*
     * Form.io's default file component renders a full drop-zone with
     * instructional text ("Drop files to attach, or Browse"), which is
     * correct but visually heavy for a composer toolbar. This trims the
     * wording to something compact WITHOUT touching how the element
     * works — it only rewrites text content Form.io already rendered,
     * the same low-risk category of change as SCA-36's tagging.
     *
     * Guarded so it only runs once per real DOM node (Form.io may
     * re-render this component on state changes, producing a fresh
     * node each time, which naturally re-triggers the trim).
     */
    function decoratePicker(pickerRoot) {
        if (pickerRoot.getAttribute("data-sca-decorated") === "true") {
            return;
        }

        var browseLink = pickerRoot.querySelector(
            'a[ref="fileBrowse"], .fileSelector a, .browse'
        );

        var dropZone = pickerRoot.querySelector(
            '[ref="fileDrop"], .fileSelector'
        );

        if (browseLink) {
            browseLink.textContent = "Attach files";
        }

        if (dropZone && !browseLink) {
            /*
             * Some Form.io templates fold the browse trigger and the
             * drop-zone label into one text node rather than a separate
             * <a>. Falling back to relabelling the whole zone keeps this
             * useful even if that's the shape encountered here.
             */
            var existingLink = dropZone.querySelector("a");

            if (existingLink) {
                existingLink.textContent = "Attach files";
            }
        }

        /*
         * Hide Form.io's own post-selection file list: the richer chip
         * tray below is the single source of truth for what's attached,
         * so showing both would be redundant and could drift out of
         * sync (e.g. Form.io shows a file our own extraction rejected).
         */
        var nativeList = pickerRoot.querySelector(
            '[ref="fileList"], ul.list-group'
        );

        if (nativeList) {
            nativeList.classList.add("sca-native-file-list-hidden");
        }

        pickerRoot.setAttribute("data-sca-decorated", "true");
        pickerRoot.setAttribute(
            "title",
            "Attach a file (" +
                (engine
                    ? engine.manager
                          .supportedExtensionList()
                          .join(", ")
                          .toUpperCase()
                          .replace(/\./g, "")
                    : "DOCX, PDF, TXT, MD") +
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
     *
     * Unchanged from v1 below this point: everything from here to the
     * end of AUI-06 operates on the raw File objects handed to it by
     * attachChangeListener() and has no dependency on how those files
     * were picked.
     * ========================================================= */

    function addFiles(files) {
        var limits = engine.manager.LIMITS;
        var room = limits.MAX_FILES - state.records.length;

        if (room <= 0) {
            setNotice(
                "You can attach up to " + limits.MAX_FILES + " files per message."
            );

            renderTray();

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
        var tray = find(SELECTORS.trayHost);

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
        var pickerRoot = find(SELECTORS.pickerRoot);

        if (pickerRoot) {
            var atFileLimit =
                state.records.length >= engine.manager.LIMITS.MAX_FILES;

            var blocked = isProcessing() || atFileLimit;

            pickerRoot.classList.toggle("sca-picker-disabled", blocked);
            pickerRoot.setAttribute("aria-disabled", blocked ? "true" : "false");

            var input = pickerRoot.querySelector('input[type="file"]');

            if (input) {
                input.disabled = blocked;
            }
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
     *
     * The picker button itself is no longer handled here: it is a real
     * <a>/<input> Form.io renders and manages, so clicking it needs no
     * help from this controller at all.
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

        mount();
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
