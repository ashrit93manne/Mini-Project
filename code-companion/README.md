# Code Companion — `.deptapp` source and build

Source, build tooling and tests for the **Code Companion** application
(exported from aXet.flows as `aXet.SAP - Code Agents`).

The importable artefact is
[`build/aXet.SAP__Code_Agents_v4.7.0_export.deptapp`](build/). Everything
else in this directory exists so that artefact can be reviewed, rebuilt
and regression-tested rather than hand-edited as an 800 KB JSON blob.

## What changed in v4.7.0

Two things, against the v4.6.2 baseline:

1. **The application menu toggle (hamburger) is removed.** See
   [`docs/MENU-REMOVAL.md`](docs/MENU-REMOVAL.md).
2. **Files can be attached to a message, and their text is extracted in
   the browser and sent to the model as grounding material.** See
   [`docs/FILE-UPLOAD.md`](docs/FILE-UPLOAD.md).

Five nodes are touched; all 46 nodes and every wire are preserved:

| Node | Change |
| --- | --- |
| `axetflows-app` — SAP Code Companion | Stylesheet: composer geometry, attachment UI, hardened menu removal |
| `axetflows-form` — SAP Code Agent Chat | Controller script v6.0.0; two new hidden state fields |
| `function` — Validate + Build SAP Agent Prompt | Reads the attachment payload, guards its size, composes the user turn |
| `function` — Extract Response + Update Chat | Records attachment metadata on the turn; clears the fields afterwards |
| `function` — Clear Conversation | New Chat clears the attachment fields |

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
    sca-attachment-ui.js       paperclip, tray, submission plumbing
    sca-app-chrome.js          menu-toggle removal
  css/
    attachments.css            composer geometry and attachment UI
    chrome.css                 hardened menu removal
tools/
  build_deptapp.py             assembles the export from baseline + src
  diff_export.py               structural comparison against the baseline
  extract.js                   prints what the engine extracts from a file
  make_test_pdfs.py            PDF fixtures via reportlab
  make_special_pdfs.py         hand-built Identity-H and no-text-layer PDFs
  make_test_docx.py            hand-built OOXML fixture
tests/
  parsers.test.js              extraction engine, under Node
  backend.test.js              Node-RED function nodes, under Node
  browser.test.js              the built export, under Chromium
  harness/                     generated page that hosts the built export
  fixtures/                    test documents and their expected text
```

## Build

```bash
npm run build
```

The build is a series of **anchored patches** against the baseline. Each
one asserts that its anchor appears exactly once; if the baseline changes
under it, the build fails loudly rather than producing a half-patched
application. There is no step that rewrites the whole file.

```bash
python3 tools/diff_export.py \
  baseline/aXet.SAP__Code_Agents_v4.6.2_export.deptapp \
  build/aXet.SAP__Code_Agents_v4.7.0_export.deptapp
```

confirms the node count, ids and wiring are untouched and lists exactly
which nodes differ.

## Test

```bash
npm test          # build, then all three suites
```

| Suite | What it covers |
| --- | --- |
| `test:parsers` | DOCX, PDF, plain text, the XML tokenizer, budget and truncation — 52 assertions |
| `test:backend` | The three patched Node-RED nodes, executed as Node-RED executes them — 31 assertions |
| `test:browser` | The built export, loaded in Chromium: layout geometry, upload, extraction, gating, payload — 63 assertions |

The browser suite loads `tests/harness/index.html`, which is generated
*from the built `.deptapp`* — so the script and stylesheet under test are
the ones the platform will actually run, and the build step is covered
too.

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

Import `build/aXet.SAP__Code_Agents_v4.7.0_export.deptapp` through the
aXet.flows application import. No new npm modules, no `settings.js`
change, and no platform configuration is required — see
[`docs/FILE-UPLOAD.md`](docs/FILE-UPLOAD.md#why-everything-runs-in-the-browser)
for why that constraint shaped the design.

## Known baseline observations

Two things were noticed while working in the baseline and left alone, as
they are outside the scope of this change:

- The flow contains a disconnected `file in` node pointing at
  `C:\Users\10139538\Downloads\test_doc.txt`, wired to a `Read file to
  LLM` function with a placeholder prompt. It appears to be an earlier
  experiment toward this feature. It is unreachable from the running
  flow, and is now superseded by SCA-37 — worth deleting in a future
  version.
- Stylesheet section 23 is scoped with `body:has(.sca-header-host)`.
  That class comes from the header HTML element's `className`, so the
  scope does resolve — but it means the whole desktop-density and
  shell-override block silently stops applying if that component is ever
  renamed.
