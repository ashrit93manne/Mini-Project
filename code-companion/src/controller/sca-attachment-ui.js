/*
 * Code Companion — Attachment UI
 *
 * Version 3.0.0
 *
 * Owns the attached-file tray and the plumbing that carries extracted
 * text into the Form.io submission.
 *
 * Why this is v3 (read before changing the intake strategy again)
 * -------------------------------------------------------------------
 * v1 built the picker — a <button> plus a synthesized
 * <input type="file"> — entirely in script. It worked in every harness
 * it was tested against and did not appear at all in the real
 * deployment.
 *
 * v2 replaced that with a DECLARED Form.io `file` component, which was
 * the right move, and then made two wrong assumptions about it:
 *
 *   1. that the component contains a persistent <input type="file">
 *      whose "change" event could be delegated from. It does not.
 *      File.browseFiles() creates an input on document.body, clicks it,
 *      and removes it again in its own change handler, so
 *      `closest('.formio-component-attachmentPicker input[type=file]')`
 *      matches nothing in any Form.io version. No file was ever
 *      ingested — the feature was completely dead in production.
 *   2. that the component's markup could be dressed up at runtime —
 *      relabelling its browse link, adding a class to hide its file
 *      list. Form.io re-renders the component whenever its value
 *      changes, and the controller runs on the form's data lifecycle
 *      rather than after paint, so whether that decoration was applied
 *      at any moment was a matter of timing. When it was not, the stock
 *      chrome showed through: an empty "File Name / Size" table above
 *      the message box and a "Drop files to attach, or browse" zone
 *      across it.
 *
 * Neither was caught because the test harness hand-wrote Form.io's
 * markup for this component, so every test validated the assumptions
 * instead of the platform. The harness now renders the real Form.io.
 *
 * v3 stops touching Form.io's internals entirely:
 *
 *   - Intake reads the component's VALUE (ingestPickerValue), which is
 *     the platform's actual contract: an array of
 *     { storage, name, url: "data:...;base64,...", size, type } objects
 *     produced by formiojs' base64 storage provider.
 *   - The component is hidden by structural CSS keyed on its own stable
 *     class (attachments.css 24B), with no dependency on any script
 *     having run.
 *   - The visible control is #sca-attach-button, plain HTML in a
 *     declared htmlelement — the one thing that has always rendered
 *     exactly as authored in the real deployment. It opens the dialog
 *     by clicking Form.io's own [ref="fileBrowse"], and removing a chip
 *     clicks Form.io's own [ref="removeLink"], so the component's value
 *     stays authoritative rather than shadowed.
 *
 * One more thing this module must respect: the controller's SCA-32
 * MutationObserver calls sync() on ANY DOM change anywhere in
 * document.body, unfiltered. Every render path here is therefore
 * idempotent — no change, no mutation, no observer callback. Skipping
 * that made attaching a file freeze the page outright (400+ sync()
 * calls from a single setValue); see renderTray().
 */

var ScaAttachmentUi = (function buildScaAttachmentUi() {
    "use strict";

    var UI_VERSION = "3.0.0";

    var SELECTORS = {
        pickerRoot: ".formio-component-attachmentPicker",
        /*
         * Form.io's own browse trigger. Clicking it is what opens the
         * file dialog — File.browseFiles() then creates a transient
         * <input type="file"> on document.body, clicks it, and removes
         * it again inside its own change handler.
         *
         * v2 listened for that input's change event via
         * `closest('.formio-component-attachmentPicker input[type=file]')`,
         * which cannot match: the input is never a descendant of the
         * component. That is why no file was ever ingested in
         * production. There is no selector for it here now, because
         * this module no longer tries to observe it at all — see
         * AUI-03's ingestPickerValue().
         */
        pickerBrowse:
            '.formio-component-attachmentPicker [ref="fileBrowse"],' +
            ".formio-component-attachmentPicker .fileSelector a",
        pickerRemoveLinks:
            '.formio-component-attachmentPicker [ref="removeLink"]',
        attachButton: "#sca-attach-button",
        trayHost: "#sca-attachment-tray",
        budgetHost: "#sca-prompt-budget",
        attachmentCounter: "#sca-attachment-counter"
    };

    /*
     * Where Form.io keeps the picker's value. `composer` and
     * `attachmentBar` are `container` components, and containers nest
     * their children's data — verified against the live renderer.
     */
    var PICKER_PATH = ["composer", "attachmentBar", "attachmentPicker"];

    var SPINNER_ICON =
        '<span class="sca-chip-spinner" aria-hidden="true"></span>';

    var controller = null;
    var engine = null;

    var state = {
        records: [],
        busy: 0,
        notice: "",
        /*
         * Keys (name|size) of the picker entries already handed to
         * addFiles(), so a value that survives across sync ticks is
         * ingested exactly once.
         */
        pickerKeys: [],

        /* Last content rendered into the tray; see renderTray(). */
        traySignature: null
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

        mountCounter();
        renderTray();

        return Boolean(pickerRoot) && Boolean(trayHost);
    }

    /* =========================================================
     * AUI-02b — INGESTION FROM THE COMPONENT VALUE
     *
     * The platform's contract for a `file` component is its VALUE, not
     * its DOM. With storage "base64", formiojs' base64 provider
     * resolves each picked file to
     *
     *   { storage: "base64", name, url: "data:<mime>;base64,<...>",
     *     size, type }
     *
     * and puts it in the submission. Reading that is stable across
     * Form.io versions, template sets, and re-renders, none of which is
     * true of the markup around it.
     * ========================================================= */

    function currentPickerValue() {
        var node = controller ? controller.latestFormData : null;

        for (var index = 0; index < PICKER_PATH.length; index += 1) {
            if (!node || typeof node !== "object") {
                return [];
            }

            node = node[PICKER_PATH[index]];
        }

        return Array.isArray(node) ? node : [];
    }

    function pickerKeyOf(entry) {
        return String(entry.name || "") + "|" + (Number(entry.size) || 0);
    }

    /* "data:text/plain;base64,AAAA" -> Uint8Array */
    function bytesFromDataUrl(url) {
        var comma = String(url || "").indexOf(",");

        if (comma < 0) {
            return null;
        }

        var binary;

        try {
            binary = window.atob(String(url).slice(comma + 1));
        } catch (error) {
            return null;
        }

        var bytes = new Uint8Array(binary.length);

        for (var index = 0; index < binary.length; index += 1) {
            bytes[index] = binary.charCodeAt(index);
        }

        return bytes;
    }

    /*
     * Turns the picker's value into the File objects the rest of this
     * module already knows how to handle, so everything downstream of
     * addFiles() — extraction, budget, truncation, chips — is reached
     * by exactly the code path it always was.
     */
    function ingestPickerValue() {
        var entries = currentPickerValue();
        var seen = [];
        var fresh = [];

        var duplicates = [];
        var duplicateIndices = [];

        entries.forEach(function (entry, index) {
            if (!entry || typeof entry !== "object") {
                return;
            }

            var key = pickerKeyOf(entry);

            /*
             * The same file picked twice appears twice in the value.
             * addFiles() would have explained that, but it is never
             * reached for an entry whose key is already ingested, so the
             * explanation is given here instead of silently doing
             * nothing.
             */
            if (seen.indexOf(key) !== -1) {
                duplicates.push(String(entry.name || ""));
                duplicateIndices.push(index);
                return;
            }

            seen.push(key);

            if (state.pickerKeys.indexOf(key) !== -1) {
                return;
            }

            var bytes = bytesFromDataUrl(entry.url);

            if (!bytes) {
                log("error", "picker-value-undecodable", { name: entry.name });
                return;
            }

            state.pickerKeys.push(key);

            fresh.push(
                new File([bytes], String(entry.name || "attachment"), {
                    type: String(entry.type || "application/octet-stream")
                })
            );
        });

        /*
         * An entry that has left the value (Form.io's own remove control,
         * or a reset) must stop counting as ingested, or re-attaching the
         * same file later would be silently ignored.
         */
        state.pickerKeys = state.pickerKeys.filter(function (key) {
            return seen.indexOf(key) !== -1;
        });

        if (fresh.length) {
            log("info", "picker-value-ingested", { count: fresh.length });
            addFiles(fresh);
        } else if (duplicates.length) {
            setNotice(
                duplicates.length === 1
                    ? duplicates[0] + " is already attached."
                    : "Those files are already attached."
            );

            renderTray();

            /*
             * Hand the redundant copy back to Form.io. Without this the
             * duplicate stays in the component's value forever, this
             * branch runs again on every sync tick, and the notice chip
             * can never be cleared by anything the developer does.
             */
            duplicateIndices
                .slice()
                .reverse()
                .forEach(function (index) {
                    releasePickerFileAt(index);
                });
        }
    }

    /*
     * Removes one entry by position. Re-queries rather than holding a
     * NodeList, for the reason given on releaseAllPickerFiles().
     */
    function releasePickerFileAt(index) {
        var links = document.querySelectorAll(SELECTORS.pickerRemoveLinks);

        if (links[index]) {
            links[index].click();
        }
    }

    /*
     * Hands a file back to Form.io by clicking its own remove control,
     * so the component's value stays authoritative rather than being
     * shadowed by this module's state.
     */
    function releasePickerFile(name, bytes) {
        var entries = currentPickerValue();
        var index = -1;

        for (var i = 0; i < entries.length; i += 1) {
            if (
                String(entries[i].name || "") === String(name) &&
                (Number(entries[i].size) || 0) === (Number(bytes) || 0)
            ) {
                index = i;
                break;
            }
        }

        if (index < 0) {
            return;
        }

        var links = document.querySelectorAll(SELECTORS.pickerRemoveLinks);

        if (links[index]) {
            links[index].click();
        }
    }

    /*
     * Form.io redraws the component after each removal, which detaches
     * every node in a previously captured NodeList — clicking the rest
     * of a stale list silently does nothing, so a first attempt at this
     * removed only one file of several and the survivors were then
     * re-ingested on the next tick. The list is re-queried each time,
     * and the loop stops as soon as a pass fails to remove anything.
     *
     * pickerKeys is deliberately NOT reset here: ingestPickerValue()
     * prunes keys that are no longer in the value, so a removal that
     * did not take leaves its key in place and the file is not
     * re-ingested.
     */
    function releaseAllPickerFiles() {
        var previous = -1;

        for (var guard = 0; guard < 50; guard += 1) {
            var links = document.querySelectorAll(SELECTORS.pickerRemoveLinks);

            if (!links.length) {
                return;
            }

            if (links.length === previous) {
                log("error", "picker-release-stalled", {
                    remaining: links.length
                });

                return;
            }

            previous = links.length;

            links[links.length - 1].click();
        }
    }

    /*
     * Opens the platform's own file dialog. The click must originate
     * from the user's click on our button so the browser's user
     * activation carries through to the transient input Form.io opens.
     */
    function openPicker() {
        var browse = find(SELECTORS.pickerBrowse);

        if (!browse) {
            log("error", "picker-browse-missing", {});
            return false;
        }

        browse.click();

        return true;
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

    /*
     * Identifies what the tray should currently show. Cheap to compute
     * and compared before any DOM is touched — see renderTray().
     */
    function traySignature() {
        return (
            state.records
                .map(function (record) {
                    return [
                        record.id,
                        record.status,
                        record.name,
                        record.bytes,
                        (record.text || "").length,
                        record.truncated ? 1 : 0
                    ].join("|");
                })
                .join("~") +
            "!" +
            String(state.notice || "")
        );
    }

    /*
     * This used to begin `tray.innerHTML = ""` unconditionally, and is
     * called from sync() — which the controller's SCA-32 MutationObserver
     * runs on ANY DOM change anywhere in document.body, unfiltered. So
     * every render mutated the DOM, which triggered the observer, which
     * rendered again: a feedback loop that starves the main thread.
     *
     * It stayed dormant only because nothing else was redrawing. Real
     * Form.io redraws the file component whenever its value changes, so
     * attaching a file lit the loop and froze the page — reproduced
     * against the real renderer as 400+ sync() calls from one setValue.
     *
     * The fix is to make rendering idempotent: no change, no mutation,
     * no observer callback. The child count is checked too, so a Form.io
     * redraw that wipes the tray still repaints it.
     */
    function renderTray() {
        var tray = find(SELECTORS.trayHost);

        if (!tray) {
            return;
        }

        var signature = traySignature();
        var expected = state.records.length + (state.notice ? 1 : 0);

        if (
            state.traySignature === signature &&
            tray.childElementCount === expected
        ) {
            renderCounter();
            return;
        }

        state.traySignature = signature;

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
            var present =
                document.body.getAttribute("data-sca-attachments") === "true";

            if (hasContent && !present) {
                document.body.setAttribute("data-sca-attachments", "true");
            } else if (!hasContent && present) {
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

        /*
         * Assigning textContent replaces child nodes even when the text
         * is identical, which is a DOM mutation the SCA-32 observer
         * reacts to. Compare first — see renderTray() above.
         */
        if (!summary.usableFiles) {
            if (!counter.hidden) {
                counter.hidden = true;
            }

            if (counter.textContent !== "") {
                counter.textContent = "";
            }

            return;
        }

        if (counter.hidden) {
            counter.hidden = false;
        }

        var text =
            " · " +
            summary.usableFiles +
            (summary.usableFiles === 1 ? " file" : " files") +
            ", " +
            summary.characters.toLocaleString() +
            " chars attached" +
            (summary.truncated ? " (truncated)" : "");

        if (counter.textContent !== text) {
            counter.textContent = text;
        }

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

        /*
         * The picker's value is released too. It is not "visual": leaving
         * the base64 payloads in the component would resend every
         * document with the next message and re-ingest them on the next
         * sync tick.
         */
        releaseAllPickerFiles();

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

        if (target.closest(SELECTORS.attachButton)) {
            event.preventDefault();
            event.stopPropagation();

            openPicker();

            return true;
        }

        var remove = target.closest("[data-attachment-remove]");

        if (remove) {
            event.preventDefault();
            event.stopPropagation();

            var id = remove.getAttribute("data-attachment-remove");
            var record = state.records[indexOf(id)];

            /*
             * Give the file back to Form.io before dropping our own
             * record, so its value never keeps a document the developer
             * has just removed — otherwise it would ride along in every
             * later submission, and re-attaching the same file would be
             * silently ignored as already present.
             */
            if (record) {
                releasePickerFile(record.name, record.bytes);
            }

            removeRecord(id);

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

    /*
     * Called from the host controller's periodic sync and after every
     * form-data change — which is exactly when a newly picked file
     * appears in the component's value.
     */
    function sync() {
        if (!engine) {
            return;
        }

        mount();
        ingestPickerValue();
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
