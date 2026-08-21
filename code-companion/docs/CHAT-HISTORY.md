# Conversation history

> Code Companion v5.2.0 — controller SCA-38, backend nodes, NoSQL persistence

A left sidebar with a "+ New Conversation" link and a scrollable list of
past conversations. Clicking a past conversation loads it back into the
chat; a delete icon on each row removes it.

## Why this exists

The product documentation's *Known Boundaries* section is explicit:

> There is no persistence across sessions today. Closing or refreshing
> the browser loses the active conversation, and only one conversation
> is active at a time.

and *Planned Next Steps* lists, unbuilt:

> Persistent, multi-conversation history with a navigable list of past
> conversations

This delivers it, using a real NoSQL module confirmed present on the
platform — `axet-flows-contrib-nodes-db-nosql`, exposing `nosql-persist`,
`nosql-query`, `nosql-find-one` and `nosql-remove` nodes — found in a
colleague's separately-exported, in-production aXet.flows app that uses
exactly this module for an admin CRUD screen (list, edit, delete, backed
by a Form.io `datagrid` with per-row action buttons). This feature
mirrors that app's wiring conventions closely, on the theory that code
proven to work in your own production environment is a safer template
than anything built from Form.io/Node-RED documentation alone.

## What changed alongside this, and why

Rebuilding chat history surfaced why the v4.7.0 file-attachment paperclip
didn't appear in the real deployment: it was a `<button>` and an
`<input type="file">` **manufactured entirely in script** and positioned
with CSS `calc()` against assumptions about the composer's exact DOM. It
worked in every local and harness test, including a browser loading the
literal built export — and still rendered nothing in production, because
those tests all reproduced the assumptions rather than the platform. The
menu-toggle removal shipped in the same release *did* work in
production, and the difference is telling: that code only ever **tags
elements the platform had already rendered**; the file picker
**manufactured new ones**.

So alongside conversation history, the file picker was rebuilt on the
same principle the sidebar now follows throughout: **prefer a declared
Form.io component the platform is already responsible for rendering over
anything this script constructs and positions itself.** See
[`FILE-UPLOAD.md`](FILE-UPLOAD.md) for the picker rewrite specifically.

## What's declared vs. what's scripted

v5.2.0 changed where the line falls. v5.0.0 let Form.io's `datagrid`
BE the visible conversation list, styled into cards. That could not
work: Form.io materialises one blank row for an empty datagrid whatever
`defaultValue: []` says, so the deployed sidebar showed a phantom row of
two editable text inputs and two icon buttons, measured 458px wide
inside a 239px column. Its header row, its "Add Another" control and its
inputs each have to be fought separately, and each is a different shape
in a different Form.io template set.

So the datagrid is now kept for its **behaviour** and hidden:

| Declared (Form.io renders it) | Scripted (this project owns it) |
| --- | --- |
| `sidebarPanel` — a `container`, positioning surface only | The sidebar's open/closed state on mobile (`data-sca-sidebar-open` on `<body>`) |
| `sidebarHeaderHtml` — an `htmlelement`, static markup | The "+ New Conversation" and refresh links inside it are plain `<button>`s whose click is delegated to **click the real Form.io button that already does the work** — `newChat` and the CSS-hidden `loadConversations` |
| `conversationListHost` — an `htmlelement` | The rows inside it. `ScaHistory.renderConversationList()` builds them from the datagrid's own value with `createElement`/`textContent` (a title is untrusted user text and must never be parsed as markup), and routes a row click to that row's real datagrid button |
| `conversationsGrid` — a `datagrid`, hidden by structural CSS (history.css 26E). Still holds the rows and still owns the `open`/`delete` buttons wired to the backend | Nothing renders from it directly |
| `loadConversations` and `newChat` — real `button` components, CSS-hidden (not `hidden: true`) | Clicking a visible link elsewhere triggers a `.click()` on them |

Hidden means `visibility: hidden` plus a 1px clip, never `display: none`
and never a class added at runtime: the buttons must stay rendered so
Form.io keeps their handlers bound and `element.click()` still reaches
them.

**The header's own "New Chat" button is hidden too** (history.css 26F2).
It duplicated the sidebar's "+ New Conversation". The component is
untouched — "+ New Conversation" works by clicking exactly that button,
and it is the one wired to the form node's New Chat output, so deleting
it would take the feature with it.

## Data model

Collection `sca-conversations`. One document per conversation:

```json
{
  "_id": "sap-mfvz9k3q-a1b2c3d4",
  "data": {
    "userId": "hariharan.ummadisetti@nttdata.com",
    "title": "Build a RAP service for sales orders...",
    "messagesJson": "[ ... the same JSON already stored in the chat's own messagesJson field ... ]",
    "currentStage": "code",
    "updatedAt": "2026-08-20T17:40:00.000Z"
  }
}
```

- **`_id` is always the conversation's existing `conversationId`** — the
  identifier the app already generates on New Chat (`"Clear
  Conversation"`) and threads through the whole session. Every persist
  call includes it explicitly. This was a deliberate design choice to
  avoid a real unknown: whether `nosql-persist` inserts unconditionally
  or upserts when `_id` is present. A colleague's app strongly suggests
  upsert-by-`_id` — the same `nosql-persist` node handles both their
  "New" and "Edit" flows, differentiated only by whether `_id` is already
  in the submitted object — but reusing an id **this app already
  generates and controls**, rather than depending on the node
  auto-generating and returning one, sidesteps the question rather than
  betting on the answer.
- **One timestamp, not two.** An earlier draft tracked `createdAt`
  separately, which would require either a read-modify-write on every
  turn or trusting the node to preserve `$setOnInsert`-style fields on
  upsert — another unverifiable assumption. `updatedAt` alone, refreshed
  on every persist, is both the sort key and the only timestamp shown.
- **No title editing, no folders, no per-conversation sharing.** Title is
  the first ~60 characters of the first user message, computed once per
  persist call; a conversation with no messages yet is never persisted
  (nothing to show in the list until there's something to load).

## When persistence happens

Tapped off the **existing** wire from `Extract Response + Update Chat` —
a `Prepare Conversation Persist` function runs in parallel with every
chat reply reaching the browser, immediately followed by `nosql-persist`.
It does not gate or delay the reply: a persistence failure logs a
warning and the conversation continues normally on screen, just without
having saved that turn.

## Backend flow

Three new `link out`/`link in` pairs on the existing UI/Backend tab
split, following the exact shape of the app's own `SAP Chat Request` /
`SAP New Chat` pair:

```
List:    loadConversations button
           -> link out "SAP List Conversations"
           -> link in (backend)
           -> Prepare Conversation List Query   (builds the userId filter)
           -> nosql-query                       (collection sca-conversations)
           -> Apply Conversation List            (reshapes into datagrid rows)
           -> axetflows-view-action (update)     "Refresh Conversations Sidebar"

Load:    a row's "open" button
           -> link out "SAP Load Conversation"
           -> link in (backend)
           -> Get Selected Conversation Id       (reads the clicked row's _id)
           -> nosql-find-one
           -> Apply Loaded Conversation          (reshapes into chat state)
           -> axetflows-view-action (update)     "Refresh Chat After Load"

Delete:  a row's "delete" button
           -> link out "SAP Delete Conversation"
           -> link in (backend)
           -> Get Delete Conversation Id
           -> nosql-remove
           -> [rejoins the List chain's own query step, so the sidebar
               refreshes with the same code that lists it in the first place]
```

`axetflows-view-action` with `action: "update"` pushes `msg.payload`
straight to the live form, the same mechanism `Refresh Chat` and
`Refresh New Chat` already use for every ordinary reply — nothing new
was invented for "push data back to the screen."

**Loading a conversation reuses the existing render pipeline entirely.**
`Apply Loaded Conversation` writes `messagesJson`/`currentStage` into the
same `msg.payload.data` shape a normal chat reply already produces; the
controller's `sync()`/`render()` — already proven, untouched — does the
rest. No new client-side rendering code exists for "show a loaded
conversation."

## Extracting the row that was clicked

A `datagrid`'s row-action buttons don't identify *which* row was
clicked through their own click event — Form.io returns the whole grid's
current value, with the clicked row's button flag set `true`. Both
extraction functions read that directly:

```js
const selected = rows.find((row) => row.open === true);
```

This is corrected from what the colleague's own app does — their
equivalent line assigns the **whole row object** to the id variable
(`msg._id = rows.find(...)`, not `rows.find(...)._id`), which functions
in their app but is not a pattern worth reproducing. This project pulls
out the string.

## What could not be verified

Everything above the "Backend flow" table was checked against a real,
working reference. Two things could not be:

1. **`nosql-persist`'s exact upsert semantics.** Sidestepped by always
   supplying `_id` explicitly (see "Data model" above) rather than
   depending on the answer.
2. **The exact shape `nosql-query` and `nosql-find-one` bind onto
   `msg.submission`/`msg.payload`** against a real database — a flat
   array of documents, or an array of `{_id, data: {...}}` envelopes
   matching the persist shape. `Apply Conversation List` and `Apply
   Loaded Conversation` handle **both** shapes defensively (see
   `tests/history-backend.test.js`), but "handles either gracefully" is
   not the same claim as "matches the real one."

**First-import verification** (do this before relying on the feature):
send two or three messages in one conversation, then check the
`sca-conversations` collection directly — it should contain **exactly
one** document for that conversation, not one per message. If it
contains one per message, `_id`-based upsert is not behaving as this
design assumes, and the persist chain needs a second look before
depending on it further.

## Known limitations

- **No pagination.** The list query fetches up to 50 most recent
  conversations; a `paginator` control was scoped out to avoid a further
  increase in the button/output-index surface (see "A note on Form.io
  button-output wiring" below) for a first version.
- **Deleting the conversation currently on screen doesn't clear the
  screen.** The messages stay visible until New Chat or another
  conversation is loaded; continuing to chat in a "deleted" conversation
  simply recreates its document on the next turn (persist is
  unconditional upsert-by-known-id), which is a safe fallback rather
  than a data-loss risk.
- **No search/filter** beyond the implicit per-user scope.
- **Desktop-only permanent panel; mobile is an overlay.** Below 901px
  the sidebar is hidden behind a toggle in the app's own header, sliding
  in over the chat rather than sharing width with it — reserving even a
  narrow column permanently would crowd an already tight composer.

## A note on Form.io button-output wiring

Every `axetflows-form` node's `outputs` count was observed, across both
this app's baseline and the colleague's reference app, to equal the
number of declared **and datagrid-row-hoisted** buttons plus exactly one
extra, seemingly-reserved output. Confirmed with two data points: this
app's own 3 buttons → 4 outputs, and the colleague's 5 buttons (`New`,
`delete`, `edit`, `paginatorButton`, `search`) → 6 outputs. This
project's 3 new buttons (`loadConversations`, `open`, `delete`) were
added on that basis — 6 buttons → 7 outputs — with the build script
(`add_conversation_history` in `tools/conversation_history.py`) asserting
the pre-change shape before touching it, so a wrong assumption here fails
the build rather than silently misrouting a button's clicks.

## Verification

- `tests/history-backend.test.js` — 30 assertions against the six new
  backend functions, executed exactly as Node-RED executes them (same
  technique as `tests/backend.test.js`), including both plausible
  query-result shapes and the not-found/malformed-input cases.
- `tests/browser.test.js`, section `SCA-38` — the sidebar panel is
  present and positioned correctly at both breakpoints, the mobile
  toggle opens and closes it (including tapping outside the panel to
  close, and staying reachable through its own overlay — an actual bug
  caught and fixed during development, see below), and "+ New
  Conversation" / refresh genuinely click the real underlying Form.io
  buttons rather than only appearing to.
- **What these cannot cover**: the datagrid's own rendering from real
  query data, and the full list → load → delete round trip against an
  actual database. No Form.io renderer or aXet.flows backend was
  available to test against; see "What could not be verified" above.

Two real bugs were caught by this test suite before shipping, worth
naming because they are the kind that would otherwise have reached
production the same way the v1 paperclip did:

- The CSS meant to give the picker/tray their own flex-sized boxes was
  briefly too broad and collapsed the picker's own component root via
  `display: contents`, which let its invisible file-input overlay escape
  its intended bounds and silently intercept clicks meant for the
  attachment tray next to it.
- The mobile sidebar toggle, once the panel it opens was showing, sat
  *behind* that panel's own z-index — reachable to open, unreachable to
  close.
