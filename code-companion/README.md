# Code Companion — `.deptapp` source and build

Source, build tooling and tests for the **Code Companion** application
(exported from aXet.flows as `aXet.SAP - Code Agents`).

The importable artefact is
[`build/aXet.SAP__Code_Companion_v5.2.0_export.deptapp`](build/). Everything
else in this directory exists so that artefact can be reviewed, rebuilt
and regression-tested rather than hand-edited as an 800 KB JSON blob.

## What changed in v5.2.0

v5.2.0 fixes the user interface. Against the v5.1.0 release:

1. **File attachment now works.** It did not before — not "worked but
   looked wrong", *no file was ever ingested*. v5.0.0/v5.1.0 listened
   for a `change` event on an `<input type="file">` inside the Form.io
   `file` component; that input does not exist in any Form.io version
   (`File.browseFiles()` creates one on `document.body` and removes it
   again), so the listener could never fire. Intake now reads the
   component's **value** — the base64 objects the platform actually
   stores. See
   [`docs/FILE-UPLOAD.md`](docs/FILE-UPLOAD.md#version-note-why-this-is-v3).
2. **The composer and sidebar are clean.** Form.io's stock chrome was
   showing through: an empty "File Name / Size" table above the message
   box, a "Drop files to attach, or browse" zone across it, and a blank
   phantom datagrid row of editable inputs in the sidebar. The `file`
   and `datagrid` components are now hidden by **structural** CSS keyed
   on their own component class — never a class added at runtime, which
   is what made the previous attempt depend on when the controller
   happened to run — and the visible attach control and conversation
   list are plain HTML in declared `htmlelement`s.
3. **The header's duplicate "New Chat" button is hidden**, leaving the
   sidebar's "+ New Conversation". The component itself is untouched:
   that link works by clicking it.
4. **The test harness renders real Form.io.** This is the change that
   made the rest findable — see below.

No flow node was added or removed: `tools/diff_export.py` reports
71 -> 71, with only the app node (stylesheet) and form node (controller,
components) changed. Every v5.1.0 RAG node is carried through untouched.

## Why the tests did not catch any of this

`tests/harness/build-harness.js` used to hand-write an approximation of
Form.io's markup for the `file` and `datagrid` components — including an
`<input type="file">` production never had, an empty file list where
Form.io always renders a "File Name / Size" header, and zero datagrid
rows where Form.io always materialises one. Every stylesheet rule and
controller routine aimed at those components was therefore written and
validated against a fiction.

The harness now renders the export's real `formStructure` through the
real Form.io renderer (`formiojs`, a devDependency), with the controller
evaluated **before** the form is rendered, which is the order the
platform uses. Two further real bugs surfaced immediately and would
otherwise have shipped:

- attaching a file **froze the page** — the controller's unfiltered
  MutationObserver plus an unconditional `innerHTML = ""` in the tray
  render formed a feedback loop, measured at 400+ `sync()` calls from a
  single attach;
- releasing files removed only the first of several, because Form.io
  redraws between removals and detaches the rest of a captured NodeList.

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
    sca-attachment-ui.js       attachment intake from the picker's value, tray, submission plumbing (v3)
    sca-app-chrome.js          menu-toggle removal
    sca-history.js             sidebar toggle, conversation-list rendering, delegated clicks
  backend/
    conversation-functions.js  the six new Node-RED function bodies, as testable JS
  css/
    attachments.css            attachment row, attach button, chip tray; hides the file component (v3)
    chrome.css                 hardened menu removal
    history.css                sidebar layout; hides the datagrid, loadConversations and newChat
tools/
  build_deptapp.py             assembles the export from the v5.1.0 base + v4.6.2 pristine + src
  conversation_history.py      conversation-history flow-node constructors (applied in v5.0.0)
  ui_v52.py                    v5.2.0 presentation reshaping (idempotent, adds no nodes)
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
  browser.test.js               the built export, rendered by real Form.io under Chromium
  harness/                      generated page that renders the built export via formiojs
  fixtures/                     test documents and their expected text
```

## Build

```bash
npm run build
```

The build takes **two inputs**:

- `--base` — the **v5.1.0** export. Everything it uniquely contains (the
  RAG ingestion/retrieval nodes and their wiring, and the already
  patched Validate/Extract/Clear function bodies) is carried through
  untouched.
- `--pristine` — the untouched **v4.6.2** export, used only as the
  source of the original controller script and stylesheet that this
  project's anchored patches are written against.

The controller and stylesheet are assembled fresh from the pristine copy
and then replace v5.1.0's wholesale. That is safe because v5.1.0's
user-interface layer was verified byte-for-byte identical to v5.0.0's —
that release added only backend flow nodes. Presentation is then
reshaped by `ui_v52.py`, which adds no buttons and asserts the form
node's `outputs`/`wires` shape is unchanged.

Every patch fails loudly rather than silently: an anchor that no longer
matches raises immediately.

```bash
python3 tools/diff_export.py \
  baseline/aXet.SAP__Code_Companion_v5.1.0_RAG.deptapp \
  build/aXet.SAP__Code_Companion_v5.2.0_export.deptapp
```

confirms every pre-existing node is either untouched or was deliberately
edited — never silently mutated. For v5.2.0 it reports **71 -> 71 nodes,
0 added**, with only the app node (stylesheet) and the form node
(controller, components) changed.

## Test

```bash
npm test          # build, then all four suites
```

| Suite | What it covers |
| --- | --- |
| `test:parsers` | DOCX, PDF, plain text, the XML tokenizer, budget and truncation — 52 assertions |
| `test:backend` | The original three patched Node-RED nodes — 31 assertions |
| `test:history-backend` | The six new conversation-history nodes, including both plausible NoSQL result shapes and not-found/malformed-input cases — 30 assertions |
| `test:browser` | The built export rendered by **real Form.io** in Chromium: layout at three breakpoints, attachment intake through the component's value, send gating, submitted payload, and the sidebar (desktop column, mobile overlay, delegated New-Conversation/refresh clicks) — 87 assertions |

**200 assertions total, all green from a clean build.**

The browser suite loads `tests/harness/index.html`, which is generated
*from the built `.deptapp`* and rendered by the real Form.io renderer —
so the script, the stylesheet AND the component markup under test are
the ones the platform will actually run, and the build step is covered
too. Nothing about the form's DOM is hand-written any more; that was the
root cause of three releases' worth of production-only failures.

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

Import `build/aXet.SAP__Code_Companion_v5.2.0_export.deptapp` through the
aXet.flows application import. No new npm modules and no CDN are
required for the browser-side code — see
[`docs/FILE-UPLOAD.md`](docs/FILE-UPLOAD.md#why-everything-runs-in-the-browser)
for why that constraint shaped the design. Conversation history **does**
depend on a platform module: `axet-flows-contrib-nodes-db-nosql`
(`nosql-persist`/`nosql-query`/`nosql-find-one`/`nosql-remove`), which
must already be installed for the flow to import cleanly — it was
confirmed present via a colleague's own export using the same module, but
was not independently re-verified against a running instance.

v5.2.0 adds **no new platform dependency**: the two `require()` calls in
the flow (`pizzip` for DOCX download, `crypto` for RAG chunk hashing)
were already present in v5.1.0. `formiojs` is a devDependency of this
repository only — it is what the test harness renders against, and none
of it ships inside the export.

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
