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

    var HISTORY_VERSION = "1.0.0";

    var SELECTORS = {
        newConversationLink: "#sca-new-conversation",
        refreshLink: "#sca-history-refresh",
        sidebarToggle: "#sca-sidebar-toggle",
        newChatButton: ".formio-component-newChat button",
        loadConversationsButton: ".formio-component-loadConversations button"
    };

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

        /*
         * A row's own "open" click should also close the sidebar on a
         * narrow screen, the same way choosing a page from a mobile nav
         * menu closes that menu — otherwise the loaded conversation is
         * hidden behind the panel the user just used to reach it.
         */
        if (
            target.closest(".formio-component-conversationsGrid .formio-component-open")
        ) {
            window.setTimeout(function () {
                if (window.matchMedia && window.matchMedia("(max-width: 900px)").matches) {
                    setSidebarOpen(false);
                }
            }, 0);
        }

        return false;
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

    return {
        version: HISTORY_VERSION,
        init: init,
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
