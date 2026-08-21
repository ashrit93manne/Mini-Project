/*
 * Code Companion — Conversation History
 *
 * Version 1.0.0
 *
 * Deliberately thin. The list itself is a DECLARED Form.io `datagrid`
 * component (key: conversationsGrid) that the backend populates through
 * the same reactive msg.payload.data channel every chat reply already
 * uses — Form.io renders the rows, Form.io renders the per-row "open"
 * and "delete" buttons, and clicking them already reaches the backend
 * through the form's normal button-output wiring (see
 * docs/CHAT-HISTORY.md for the wiring). None of that needs help from
 * this script.
 *
 * What this script actually owns:
 *   - triggering the real, CSS-hidden "loadConversations" button when
 *     the sidebar should refresh (on boot, and from a small "refresh"
 *     link in the sidebar header) — clicking a real Form.io button
 *     rather than fabricating a network call keeps this on the exact
 *     same submission path every other action already uses;
 *   - triggering the real "newChat" button from the sidebar's
 *     "+ New Conversation" link, so New Chat's fully proven reset logic
 *     is reused rather than re-implemented;
 *   - the sidebar's own show/hide toggle on narrow screens.
 *
 * Every one of these is "find a real button Form.io already rendered
 * and click it" or "toggle one attribute on <body>" — the same category
 * of low-risk operation SCA-36's chrome removal already relies on, and
 * explicitly NOT the category that v1's file-picker mounting used.
 */

var ScaHistory = (function buildScaHistory() {
    "use strict";

    var HISTORY_VERSION = "2.0.0";

    var SELECTORS = {
        newConversationLink: "#sca-new-conversation",
        refreshLink: "#sca-history-refresh",
        sidebarToggle: "#sca-sidebar-toggle",
        newChatButton: ".formio-component-newChat button",
        loadConversationsButton: ".formio-component-loadConversations button",
        listHost: "#sca-conversation-list",
        gridRows: ".formio-component-conversationsGrid tbody tr"
    };

    /*
     * Where Form.io keeps the datagrid's value. `sidebarPanel` is a
     * `container`, and containers nest their children's data.
     */
    var GRID_PATH = ["sidebarPanel", "conversationsGrid"];

    var controller = null;
    var triggeredInitialLoad = false;

    function log(level, event, details) {
        if (typeof window.__scaLog === "function") {
            window.__scaLog(level, "SCA-38", event, details);
        }
    }

    function find(selector) {
        try {
            return document.querySelector(selector);
        } catch (error) {
            return null;
        }
    }

    /* =========================================================
     * HIS-01 — CLICK-A-REAL-BUTTON HELPERS
     * ========================================================= */

    function clickRealButton(selector, label) {
        var button = find(selector);

        if (!button) {
            log("warn", "real-button-not-found", { label: label, selector: selector });
            return false;
        }

        if (button.disabled) {
            return false;
        }

        button.click();

        return true;
    }

    function refreshConversationList() {
        clickRealButton(SELECTORS.loadConversationsButton, "loadConversations");
    }

    function startNewConversation() {
        clickRealButton(SELECTORS.newChatButton, "newChat");

        /*
         * A brand-new conversation has no document yet — the sidebar
         * list does not need to change for it to appear there (it
         * won't exist until the first message is sent and persisted).
         * No refresh call here on purpose.
         */
    }

    /* =========================================================
     * HIS-02 — SIDEBAR VISIBILITY
     *
     * Mirrors the existing data-sca-attachments toggle exactly: one
     * boolean attribute on <body>, styled entirely in CSS.
     * ========================================================= */

    function isSidebarOpen() {
        return document.body.getAttribute("data-sca-sidebar-open") === "true";
    }

    function setSidebarOpen(open) {
        if (open) {
            document.body.setAttribute("data-sca-sidebar-open", "true");
        } else {
            document.body.removeAttribute("data-sca-sidebar-open");
        }
    }

    function toggleSidebar() {
        setSidebarOpen(!isSidebarOpen());
    }

    /* =========================================================
     * HIS-03 — EVENTS
     *
     * Returns true when the event was a history/sidebar interaction, so
     * the host controller's click handler can stop processing it.
     * ========================================================= */

    function handleClick(event) {
        var target =
            event && event.target instanceof Element ? event.target : null;

        if (!target) {
            return false;
        }

        if (target.closest(SELECTORS.newConversationLink)) {
            event.preventDefault();
            event.stopPropagation();

            startNewConversation();

            return true;
        }

        if (target.closest(SELECTORS.refreshLink)) {
            event.preventDefault();
            event.stopPropagation();

            refreshConversationList();

            return true;
        }

        if (target.closest(SELECTORS.sidebarToggle)) {
            event.preventDefault();
            event.stopPropagation();

            toggleSidebar();

            return true;
        }

        /*
         * The scrim behind the open mobile sidebar (history.css 26B) is
         * a ::before pseudo-element, which cannot carry its own click
         * listener — this is that listener's real equivalent. Tapping
         * anywhere outside the panel while it is open closes it; the
         * toggle button itself is excluded so its own handler above,
         * not this one, decides what a tap on it does.
         */
        if (
            isSidebarOpen() &&
            !target.closest(".sca-sidebar-panel") &&
            !target.closest(SELECTORS.sidebarToggle)
        ) {
            event.preventDefault();
            event.stopPropagation();

            setSidebarOpen(false);

            return true;
        }

        var remove = target.closest("[data-sca-conversation-delete]");

        if (remove) {
            event.preventDefault();
            event.stopPropagation();

            clickRowButton(
                remove.getAttribute("data-sca-conversation-delete"),
                "delete"
            );

            return true;
        }

        var open = target.closest("[data-sca-conversation-open]");

        if (open) {
            event.preventDefault();
            event.stopPropagation();

            clickRowButton(
                open.getAttribute("data-sca-conversation-open"),
                "open"
            );

            /*
             * On a narrow screen the sidebar is an overlay, so choosing
             * a conversation should close it — otherwise the one just
             * loaded is hidden behind the panel used to reach it.
             */
            if (
                window.matchMedia &&
                window.matchMedia("(max-width: 900px)").matches
            ) {
                setSidebarOpen(false);
            }

            return true;
        }

        return false;
    }

    /* =========================================================
     * HIS-03b — THE VISIBLE CONVERSATION LIST
     *
     * The datagrid holds the rows and owns the buttons wired to the
     * backend; it is hidden (history.css 26E). This renders what the
     * developer sees, from the datagrid's own value, and routes a click
     * on a rendered row to that row's real button — the same technique
     * "+ New Conversation" already uses to reach the real New Chat
     * button, which is the one pattern that has always worked in the
     * real deployment.
     * ========================================================= */

    function conversationRows() {
        var node = controller ? controller.latestFormData : null;

        for (var index = 0; index < GRID_PATH.length; index += 1) {
            if (!node || typeof node !== "object") {
                return [];
            }

            node = node[GRID_PATH[index]];
        }

        if (!Array.isArray(node)) {
            return [];
        }

        /*
         * Form.io materialises one blank row for an empty datagrid
         * whatever `defaultValue: []` says, and that row arrives here
         * looking like a conversation with no title. Rendering it gave
         * the deployed sidebar a phantom "Untitled conversation" entry
         * pointing at nothing.
         */
        return node.filter(function (row) {
            if (!row || typeof row !== "object") {
                return false;
            }

            return Boolean(
                String(row._id || "").trim() || String(row.title || "").trim()
            );
        });
    }

    function listSignature(rows) {
        return rows
            .map(function (row) {
                return (
                    String((row && row.title) || "") +
                    "\u0001" +
                    String((row && row.updatedAtLabel) || "")
                );
            })
            .join("\u0002");
    }

    /*
     * Called on every sync tick, so it must be cheap when nothing has
     * changed: re-rendering unconditionally would throw away the row
     * the pointer is over several times a second.
     */
    function renderConversationList() {
        var host = find(SELECTORS.listHost);

        if (!host) {
            return;
        }

        var rows = conversationRows();
        var signature = listSignature(rows);

        if (host.getAttribute("data-sca-list-signature") === signature) {
            return;
        }

        host.setAttribute("data-sca-list-signature", signature);

        while (host.firstChild) {
            host.removeChild(host.firstChild);
        }

        if (!rows.length) {
            var empty = document.createElement("p");

            empty.className = "sca-conversation-empty";
            empty.textContent = "No conversations yet.";

            host.appendChild(empty);

            return;
        }

        rows.forEach(function (row, index) {
            host.appendChild(buildConversationItem(row, index));
        });

        log("info", "conversation-list-rendered", { count: rows.length });
    }

    /*
     * Built with createElement/textContent rather than innerHTML: a
     * conversation's title is the first line of whatever the developer
     * typed, so it is untrusted text and must never be parsed as markup.
     */
    function buildConversationItem(row, index) {
        var item = document.createElement("div");

        item.className = "sca-conversation-item";

        var open = document.createElement("button");

        open.type = "button";
        open.className = "sca-conversation-row";
        open.setAttribute("data-sca-conversation-open", String(index));

        var title = document.createElement("span");

        title.className = "sca-conversation-title";
        title.textContent =
            String((row && row.title) || "").trim() || "Untitled conversation";

        var when = document.createElement("span");

        when.className = "sca-conversation-time";
        when.textContent = String((row && row.updatedAtLabel) || "");

        open.appendChild(title);
        open.appendChild(when);

        var remove = document.createElement("button");

        remove.type = "button";
        remove.className = "sca-conversation-delete";
        remove.setAttribute("data-sca-conversation-delete", String(index));
        remove.setAttribute("aria-label", "Delete this conversation");
        remove.title = "Delete this conversation";
        remove.textContent = "\u2715";

        item.appendChild(open);
        item.appendChild(remove);

        return item;
    }

    /* Clicks the datagrid's own button for one row. */
    function clickRowButton(index, kind) {
        var rows = document.querySelectorAll(SELECTORS.gridRows);
        var row = rows[Number(index)];

        if (!row) {
            log("error", "grid-row-missing", { index: index, kind: kind });
            return false;
        }

        var button = row.querySelector(
            ".formio-component-" + kind + " button"
        );

        if (!button) {
            log("error", "grid-row-button-missing", {
                index: index,
                kind: kind
            });

            return false;
        }

        button.click();

        return true;
    }

    /* =========================================================
     * HIS-04 — LIFECYCLE
     * ========================================================= */

    function init(hostController) {
        controller = hostController;

        /*
         * One automatic refresh per page load, once — not on every
         * sync() tick. Guarded so a re-init (SCA-04's stale-controller
         * teardown/rebuild) does not click it again mid-session.
         */
        if (!triggeredInitialLoad) {
            triggeredInitialLoad = true;

            window.setTimeout(function () {
                refreshConversationList();
            }, 400);
        }
    }

    /* Called from the host controller's periodic sync. */
    function sync() {
        renderConversationList();
    }

    return {
        version: HISTORY_VERSION,
        init: init,
        sync: sync,
        renderConversationList: renderConversationList,
        handleClick: handleClick,
        startNewConversation: startNewConversation,
        refreshConversationList: refreshConversationList,
        toggleSidebar: toggleSidebar,
        isSidebarOpen: isSidebarOpen
    };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = ScaHistory;
}
