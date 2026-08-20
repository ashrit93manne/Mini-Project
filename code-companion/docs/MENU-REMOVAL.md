# Removing the application menu toggle

> Code Companion v4.7.0 — controller SCA-36, stylesheet section 25

Code Companion is a single-screen application. Its own header carries
the branding and the four-stage progress indicator; the platform shell's
hamburger opened a menu with exactly one entry, pointing at the screen
the user was already on.

## Why the existing CSS did not work

The baseline stylesheet already had a section aimed at this:

```css
/* 23B. REMOVE / DISABLE HAMBURGER AND SIDEBAR TOGGLES */
body:has(.sca-header-host) :where(.navbar-toggler,
    .sidebar-toggle, .menu-toggle, .hamburger, …) { display: none !important; }
```

and the hamburger was still on screen. The scope resolves correctly —
`.sca-header-host` is the header HTML element's `className`, so it is
present in the DOM — but the aXet shell does not use any of the class
names in that list. A blind list of selectors can only ever match markup
someone predicted.

## What replaces it

Two mechanisms, deliberately overlapping.

### Stylesheet section 25 — identify by shape

Widened from "what the control might be called" to "what the control
looks like in markup":

- **the glyph itself** — an icon-font child matching `fa-bars`,
  `fa-navicon`, `fa-reorder`, `bi-list`, `icon-menu`, `mdi-menu`,
  `glyphicon-menu-hamburger`, `pi-bars`, whatever the parent is called;
- **the accessible name** — `aria-label` or `title` mentioning menu,
  navigation, sidebar or drawer; `aria-controls` pointing at a sidebar,
  sidenav, drawer or offcanvas;
- **the class-name conventions**, kept as a superset of the original
  list, plus the Angular Material and PrimeNG spellings.

The rule hides the *clickable ancestor* rather than the icon alone, so
an empty but still-clickable button is not left behind, and reclaims the
left-hand spacer the brand kept beside it.

CSS applies before first paint, so the control never flashes.

### Controller SCA-36 — identify at runtime

`ScaAppChrome` finds the control by what it is: an icon-sized clickable
element carrying a recognised menu glyph, or one whose accessible name
says it toggles navigation. It walks up to the element that actually
receives the click, tags it `data-sca-chrome-hidden="true"`, and hides it
with inline styles — which beat any shell rule without having to win a
specificity contest against markup this code cannot see.

A `MutationObserver` re-runs it, because some shells mount or re-render
their header after the application loads. Section 25A makes the removal
survive a later re-style.

## Safety

- **Nothing inside `.formio-form`, `.sca-header`, `.sca-composer` or
  `.sca-chat-surface` is ever touched** — that is the application,
  including the composer's own paperclip button, which is additionally
  excluded by id.
- **Anything carrying real text is refused.** An element with more than
  two non-whitespace characters is a navigation item or a branding
  block, not an icon toggle.
- **`ScaAppChrome.restore()`** undoes everything the module hid.
- **`ENABLE_CHROME_CLEANUP`** at the top of `sca-app-chrome.js` turns the
  whole thing off without removing the code.

## What was deliberately not done

The app node's `menu` array — the one entry the toggle opened — was left
in place. Emptying it is the root-cause fix and would have been tidier,
but that entry also carries `form_id` and `form_permissions:
["ROLE_PUBLIC"]`. Whether the shell uses it for routing or access control
cannot be determined from the export alone, and getting it wrong makes
the application unreachable rather than merely untidy. Hiding the control
is reversible; removing the only route to the form may not be.

If the platform team can confirm the menu array is presentation-only,
emptying it is a clean follow-up and both mechanisms above become
redundant.

## Verification

`tests/browser.test.js` loads the built export into Chromium against a
stand-in shell whose hamburger uses **no** conventional toggle class —
the case the original CSS missed — and asserts that it is hidden, tagged,
non-clickable, that a hamburger added to the DOM afterwards is also
removed, and that the application's own header and paperclip survive.
