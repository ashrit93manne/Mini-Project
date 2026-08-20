# Code Companion — `.deptapp` source and build

Source, build tooling and tests for the **Code Companion** application
(exported from aXet.flows as `aXet.SAP - Code Agents`).

The importable artefact is
[`build/aXet.SAP__Code_Agents_v5.0.0_export.deptapp`](build/). Everything
else in this directory exists so that artefact can be reviewed, rebuilt
and regression-tested rather than hand-edited as an 800 KB JSON blob.

## What changed in v5.0.0

Two things, against the v4.7.0 release:

1. **File attachment was rewritten (v2).** v4.7.0's paperclip was built
   entirely in script and never appeared in the real deployment. It is
   now a **declared Form.io `file` component**, the same category of
   change that made the v4.7.0 hamburger removal work where the
   paperclip did not. See
   [`docs/FILE-UPLOAD.md`](docs/FILE-UPLOAD.md#version-note-why-this-is-v2).
2. **Persistent conversation history**, with a sidebar for starting a
   new conversation and revisiting past ones — the second item from the
   product documentation's *Planned Next Steps*. See
   [`docs/CHAT-HISTORY.md`](docs/CHAT-HISTORY.md).

Both changes follow the same principle, learned from *why* the v4.7.0
paperclip failed: prefer a Form.io component the platform is already
responsible for rendering over anything this script constructs and
positions itself. `docs/CHAT-HISTORY.md` has the full account, including
two real bugs the test suite caught before shipping.

23 nodes are touched or added; every pre-existing node's own content is
either byte-identical to the baseline or was already touched in v4.7.0
— nothing already working was silently modified (`tools/diff_export.py`
verifies this on every build):

| Node | Change |
| --- | --- |
| `axetflows-app` — SAP Code Companion | Stylesheet: attachment-bar layout (v2), sidebar layout |
| `axetflows-form` — SAP Code Agent Chat | Controller script v7.0.0; `attachmentPicker`/`attachmentTrayHost` (replacing the injected paperclip), `sidebarPanel`/`conversationsGrid`/`loadConversations` (new); 3 new form outputs |
| `function` — Extract Response + Update Chat | Tapped (not replaced): also feeds the new conversation-persist chain |
| `function` — Clear Conversation | Unchanged since v4.7.0 (already resets attachment fields; conversation id reset was already implicit) |
| 18 new nodes | Conversation-history persistence and sidebar wiring — see `docs/CHAT-HISTORY.md` |

## Layout

```
baseline/    the v4.6.2 export, treated as read-only input
build/       the generated, importable .deptapp
src/
  controller/  browser modules, concatenated ahead of the controller
    sca-attachments.js         ZIP, inflate, XML tokenizer, primitives
    sca-docx.js                Word extraction
    sca-pdf.js                 PDF extraction
    sca-attachment-manager.js  type dispatch, budget, truncation, prompt block
    sca-attachment-ui.js       native file-picker listener, tray, submission plumbing (v2)
    sca-app-chrome.js          menu-toggle removal
    sca-history.js             sidebar toggle, delegated New-Conversation/refresh clicks
  backend/
    conversation-functions.js  the six new Node-RED function bodies, as testable JS
  css/
    attachments.css            attachment-bar layout and chip tray (v2)
    chrome.css                 hardened menu removal
    history.css                sidebar layout, desktop column / mobile overlay
tools/
  build_deptapp.py             assembles the export from baseline + src
  conversation_history.py      constructs the 18 new conversation-history flow nodes
  node_builders.py             Form.io/Node-RED node constructors used by the above
  diff_export.py               structural comparison against the baseline
  extract.js                   prints what the engine extracts from a file
  make_test_pdfs.py            PDF fixtures via reportlab
  make_special_pdfs.py         hand-built Identity-H and no-text-layer PDFs
  make_test_docx.py            hand-built OOXML fixture
tests/
  parsers.test.js              extraction engine, under Node
  backend.test.js               the original three patched Node-RED nodes
  history-backend.test.js       the six new conversation-history nodes
  browser.test.js               the built export, under Chromium
  harness/                      generated page that hosts the built export
  fixtures/                     test documents and their expected text
```

## Build

```bash
npm run build
```

The build is a series of **anchored patches** against the baseline
(existing function bodies, the CSS, the controller script) plus one
**programmatic construction step** (`conversation_history.py`) for the
18 entirely new flow nodes conversation history needs — text-patching
doesn't fit adding new graph nodes, since there is no existing anchor to
attach to. Both fail loudly rather than silently: a patch whose anchor
no longer matches raises immediately, and the new-node step asserts the
form's exact `outputs`/`wires` shape before touching it.

```bash
python3 tools/diff_export.py \
  baseline/aXet.SAP__Code_Agents_v4.6.2_export.deptapp \
  build/aXet.SAP__Code_Agents_v5.0.0_export.deptapp
```

confirms every pre-existing node is either untouched or was deliberately
edited — never silently mutated — and lists the 18 new nodes by name.

## Test

```bash
npm test          # build, then all four suites
```

| Suite | What it covers |
| --- | --- |
| `test:parsers` | DOCX, PDF, plain text, the XML tokenizer, budget and truncation — 52 assertions |
| `test:backend` | The original three patched Node-RED nodes — 31 assertions |
| `test:history-backend` | The six new conversation-history nodes, including both plausible NoSQL result shapes and not-found/malformed-input cases — 30 assertions |
| `test:browser` | The built export, loaded in Chromium: layout at three breakpoints, native file-picker extraction, send gating, submitted payload, and the sidebar (desktop column, mobile overlay, delegated New-Conversation/refresh clicks) — 77 assertions |

**190 assertions total, all green from a clean build.**

The browser suite loads `tests/harness/index.html`, which is generated
*from the built `.deptapp`* — so the script and stylesheet under test are
the ones the platform will actually run, and the build step is covered
too. Its markup for the Form.io `file` and `datagrid` components is a
best-effort reproduction (no real Form.io renderer is available in this
environment) — see `docs/FILE-UPLOAD.md` and `docs/CHAT-HISTORY.md` for
exactly what that does and doesn't verify.

Fixtures are checked in. To regenerate them:

```bash
npm run fixtures    # needs reportlab; pikepdf for the objstm/encrypted pair
```

`tests/fixtures/real-documentation.docx` is the Code Companion product
document, used to assert extraction against a real-world file rather than
a synthetic one. It is optional — the browser suite skips that section
rather than failing if you remove it.

To see what the engine makes of any document:

```bash
node tools/extract.js path/to/Specification.docx
node tools/extract.js path/to/Requirements.pdf --stats
```

## Importing

Import `build/aXet.SAP__Code_Agents_v5.0.0_export.deptapp` through the
aXet.flows application import. No new npm modules and no CDN are
required for the browser-side code — see
[`docs/FILE-UPLOAD.md`](docs/FILE-UPLOAD.md#why-everything-runs-in-the-browser)
for why that constraint shaped the design. Conversation history **does**
depend on a platform module: `axet-flows-contrib-nodes-db-nosql`
(`nosql-persist`/`nosql-query`/`nosql-find-one`/`nosql-remove`), which
must already be installed for the flow to import cleanly — it was
confirmed present via a colleague's own export using the same module, but
was not independently re-verified against a running instance.

**Before relying on conversation history**, run the first-import check
in [`docs/CHAT-HISTORY.md`](docs/CHAT-HISTORY.md#what-could-not-be-verified):
send a few messages in one conversation, then confirm the
`sca-conversations` collection holds exactly one document for it, not
one per message.

## Known baseline observations

- The flow contains a disconnected `file in` node pointing at
  `C:\Users\10139538\Downloads\test_doc.txt`, wired to a `Read file to
  LLM` function with a placeholder prompt. It appears to be an earlier,
  abandoned experiment toward file attachment. It is unreachable from the
  running flow and is now superseded by this project's own attachment
  pipeline — worth deleting in a future version.
- Stylesheet section 23 is scoped with `body:has(.sca-header-host)`.
  That class comes from the header HTML element's `className`, so the
  scope does resolve — but it means the whole desktop-density and
  shell-override block silently stops applying if that component is ever
  renamed.
- An `axetflows-form` node's `outputs` count was observed, across this
  app and a colleague's separate one, to equal the number of declared
  (and datagrid-row-hoisted) buttons plus one seemingly-reserved extra —
  see `docs/CHAT-HISTORY.md` for the two data points behind that
  inference and how the build defends against it being wrong.
