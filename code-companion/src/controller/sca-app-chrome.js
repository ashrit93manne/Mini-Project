/*
 * Code Companion — Application Chrome
 *
 * Version 1.0.0
 *
 * Removes the platform shell's hamburger / sidebar toggle from the
 * Code Companion screen.
 *
 * Why this is script and not only CSS
 * -----------------------------------
 * The stylesheet already carried a section (23B) listing the usual
 * toggle class names — .navbar-toggler, .sidebar-toggle, .hamburger and
 * so on — and the control was still on screen, because the aXet shell
 * does not use any of those names. A blind list of selectors can only
 * ever match markup someone predicted.
 *
 * This module identifies the control by what it *is* rather than by what
 * it is called: an icon-sized clickable element carrying a recognised
 * menu glyph, or one whose accessible name says it toggles navigation.
 * The hardened CSS is kept alongside it as the no-JavaScript fallback,
 * and because CSS applies before first paint the control never flashes.
 *
 * Scope and safety
 * ----------------
 * Nothing inside .formio-form is ever touched — that is the application
 * itself, including the composer's own paperclip button. Every element
 * hidden is tagged with data-sca-chrome-hidden and can be restored by
 * calling restore(), and the whole module is behind a single flag.
 */

var ScaAppChrome = (function buildScaAppChrome() {
    "use strict";

    var CHROME_VERSION = "1.0.0";

    /*
     * Set to false to leave the platform header exactly as the shell
     * renders it, without removing the CSS or this module.
     */
    var ENABLE_CHROME_CLEANUP = true;

    var HIDDEN_ATTRIBUTE = "data-sca-chrome-hidden";

    /*
     * Regions the application owns. A candidate inside any of these is
     * never a shell control.
     */
    var PROTECTED = [
        ".formio-form",
        ".sca-header",
        ".sca-composer",
        ".formio-component-composer",
        ".sca-chat-surface"
    ].join(", ");

    /* Named toggles, for the shells that do use a conventional class. */
    var NAMED_TOGGLES = [
        ".navbar-toggler",
        ".sidebar-toggle",
        ".sidebar-toggler",
        ".sidenav-toggle",
        ".menu-toggle",
        ".menu-toggler",
        ".nav-toggle",
        ".drawer-toggle",
        ".hamburger",
        ".hamburger-button",
        ".hamburger-menu",
        '[data-widget="pushmenu"]',
        '[data-toggle="offcanvas"]',
        'button[aria-controls*="sidebar" i]',
        'button[aria-controls*="sidenav" i]',
        'button[aria-controls*="drawer" i]',
        'button[aria-label*="toggle sidebar" i]',
        'button[aria-label*="toggle navigation" i]',
        'button[aria-label*="toggle menu" i]',
        'button[aria-label*="open menu" i]',
        'button[aria-label*="main menu" i]',
        'button[title*="toggle sidebar" i]',
        'button[title*="toggle navigation" i]'
    ].join(", ");

    /* Icon-font class fragments used for a menu glyph. */
    var ICON_CLASS_PATTERN = /(^|[\s-])(fa-bars|fa-navicon|fa-reorder|bi-list|icon-menu|menu-icon|ci-menu|pi-bars|glyphicon-menu-hamburger|mdi-menu)([\s-]|$)/i;

    /* The glyph itself, when the shell simply prints a character. */
    var GLYPH_PATTERN = /^[≡☰⋮⋯︙]$/;

    var observer = null;
    var hiddenCount = 0;

    function log(level, event, details) {
        if (typeof window.__scaLog === "function") {
            window.__scaLog(level, "SCA-36", event, details);
        }
    }

    /* =========================================================
     * CHR-01 — CANDIDATE DISCOVERY
     * ========================================================= */

    function collectCandidates() {
        var candidates = [];

        pushAll(candidates, query(NAMED_TOGGLES));
        pushAll(candidates, queryIconElements());
        pushAll(candidates, queryGlyphElements());

        return candidates;
    }

    function query(selector) {
        try {
            return Array.prototype.slice.call(document.querySelectorAll(selector));
        } catch (error) {
            return [];
        }
    }

    function pushAll(target, items) {
        items.forEach(function (item) {
            if (item && target.indexOf(item) === -1) {
                target.push(item);
            }
        });
    }

    /*
     * Icon fonts render as an empty <i>/<span> whose class names carry
     * the glyph. Scanning every such element and matching on the class
     * catches the shells that name their toggle something unguessable.
     */
    function queryIconElements() {
        return query("i[class], span[class], svg[class], em[class]").filter(
            function (element) {
                return ICON_CLASS_PATTERN.test(element.getAttribute("class") || "");
            }
        );
    }

    function queryGlyphElements() {
        return query("button, a, span, div, i").filter(function (element) {
            /*
             * Only leaf nodes: a container that happens to contain the
             * glyph deeper down is not itself the control.
             */
            if (element.children.length > 0) {
                return false;
            }

            return GLYPH_PATTERN.test((element.textContent || "").trim());
        });
    }

    /* =========================================================
     * CHR-02 — RESOLUTION AND SAFETY
     * ========================================================= */

    /*
     * Walks up from the glyph to the element that actually receives the
     * click, so the whole control disappears rather than leaving an
     * empty, still-clickable button behind.
     */
    function resolveControl(element) {
        var clickable = element.closest(
            'button, a, [role="button"], [role="menuitem"], label'
        );

        var control = clickable || element;

        /*
         * Refuse anything that carries real text: that is a navigation
         * item or a branding block, not an icon toggle.
         */
        var text = (control.textContent || "").replace(/\s+/g, "");

        if (text.length > 2 && !GLYPH_PATTERN.test(text)) {
            return null;
        }

        return control;
    }

    function isProtected(element) {
        if (!element || element === document.body || element === document.documentElement) {
            return true;
        }

        try {
            if (element.closest(PROTECTED)) {
                return true;
            }
        } catch (error) {
            return true;
        }

        /* Never hide the application's own controls. */
        if (
            element.id === "sca-attach-button" ||
            element.closest("#sca-attachment-bar")
        ) {
            return true;
        }

        return false;
    }

    /* =========================================================
     * CHR-03 — APPLY
     * ========================================================= */

    function hide(element) {
        if (element.getAttribute(HIDDEN_ATTRIBUTE) === "true") {
            return false;
        }

        element.setAttribute(HIDDEN_ATTRIBUTE, "true");

        /*
         * Inline styles beat any shell rule without needing to win a
         * specificity contest against markup this code cannot see.
         */
        element.style.setProperty("display", "none", "important");
        element.style.setProperty("visibility", "hidden", "important");
        element.style.setProperty("pointer-events", "none", "important");

        element.setAttribute("aria-hidden", "true");
        element.setAttribute("tabindex", "-1");

        if (typeof element.disabled === "boolean") {
            element.disabled = true;
        }

        hiddenCount += 1;

        return true;
    }

    function apply() {
        if (!ENABLE_CHROME_CLEANUP || !document.body) {
            return 0;
        }

        var hiddenNow = 0;

        collectCandidates().forEach(function (candidate) {
            var control = resolveControl(candidate);

            if (!control || isProtected(control)) {
                return;
            }

            if (hide(control)) {
                hiddenNow += 1;

                log("info", "menu-toggle-hidden", {
                    tag: control.tagName,
                    className:
                        typeof control.className === "string"
                            ? control.className
                            : "",
                    ariaLabel: control.getAttribute("aria-label") || ""
                });
            }
        });

        return hiddenNow;
    }

    /* Undoes everything this module hid. */
    function restore() {
        query("[" + HIDDEN_ATTRIBUTE + '="true"]').forEach(function (element) {
            element.removeAttribute(HIDDEN_ATTRIBUTE);
            element.style.removeProperty("display");
            element.style.removeProperty("visibility");
            element.style.removeProperty("pointer-events");
            element.removeAttribute("aria-hidden");
            element.removeAttribute("tabindex");

            if (typeof element.disabled === "boolean") {
                element.disabled = false;
            }
        });

        hiddenCount = 0;
    }

    /* =========================================================
     * CHR-04 — LIFECYCLE
     *
     * The shell may mount its header after the application, and some
     * shells re-render it on navigation, so one pass at startup is not
     * enough. The observer is scoped to the shell's own subtree changes
     * and does nothing while the application re-renders itself.
     * ========================================================= */

    function init() {
        if (!ENABLE_CHROME_CLEANUP) {
            return;
        }

        apply();

        if (observer || typeof MutationObserver !== "function") {
            return;
        }

        try {
            observer = new MutationObserver(function (mutations) {
                var relevant = mutations.some(function (mutation) {
                    return (
                        mutation.addedNodes &&
                        mutation.addedNodes.length > 0 &&
                        !isProtected(mutation.target)
                    );
                });

                if (relevant) {
                    apply();
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        } catch (error) {
            log("error", "chrome-observer-failed", {
                message: error && error.message
            });
        }
    }

    function destroy() {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
    }

    return {
        version: CHROME_VERSION,
        enabled: ENABLE_CHROME_CLEANUP,
        init: init,
        apply: apply,
        restore: restore,
        destroy: destroy,
        hiddenCount: function () {
            return hiddenCount;
        }
    };
})();

if (typeof module !== "undefined" && module.exports) {
    module.exports = ScaAppChrome;
}
