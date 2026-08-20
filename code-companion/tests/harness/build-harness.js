/*
 * Builds tests/harness/index.html from the BUILT .deptapp.
 *
 * The point is that the harness runs exactly the script and stylesheet
 * that ship inside the export — not the sources they were assembled
 * from — so the browser test covers the build step as well as the code.
 *
 * The surrounding page reproduces the DOM the application actually runs
 * in: the Form.io wrapper classes, the composer with its textarea and
 * send button, the hidden state fields, the prompt-budget block, and a
 * platform header carrying a hamburger control of the kind the shell
 * renders.
 */

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ROOT = path.join(HERE, "..", "..");

const APP_NODE_ID = "5439b0c95ce6e66d";
const FORM_NODE_ID = "21d415924e0e4841";

function main() {
    const exportPath =
        process.argv[2] ||
        path.join(ROOT, "build", "aXet.SAP__Code_Agents_v5.0.0_export.deptapp");

    const data = JSON.parse(fs.readFileSync(exportPath, "utf8"));
    const flows = data.flowsData.flows;
    const byId = Object.fromEntries(flows.map((node) => [node.id, node]));

    const css = byId[APP_NODE_ID].customCSS;

    const form = byId[FORM_NODE_ID];
    const components = form.formStructure.components;

    const controller = components.find(
        (component) => component.key === "serverSideJavaScript"
    ).content;

    const headerHtml = components.find(
        (component) => component.key === "sapCodeAgentHeader"
    ).content;

    const surfaceHtml = components.find(
        (component) => component.key === "chatSurfaceHtml"
    ).content;

    const budgetHtml = findNested(components, "promptBudget").content;

    const sidebarHeaderHtml = findNested(components, "sidebarHeaderHtml");
    const trayHostHtml = findNested(components, "attachmentTrayHost");

    const page = renderPage({
        css,
        controller,
        headerHtml,
        surfaceHtml,
        budgetHtml,
        sidebarHeaderHtml: sidebarHeaderHtml ? sidebarHeaderHtml.content : "",
        trayHostHtml: trayHostHtml ? trayHostHtml.content : ""
    });

    fs.writeFileSync(path.join(HERE, "index.html"), page, "utf8");

    console.log(
        "harness written (controller " +
            controller.length.toLocaleString() +
            " chars, css " +
            css.length.toLocaleString() +
            " chars)"
    );
}

function findNested(components, key) {
    for (const component of components) {
        if (component.key === key) {
            return component;
        }

        if (Array.isArray(component.components)) {
            const found = findNested(component.components, key);

            if (found) {
                return found;
            }
        }
    }

    return null;
}

function renderPage({
    css,
    controller,
    headerHtml,
    surfaceHtml,
    budgetHtml,
    sidebarHeaderHtml,
    trayHostHtml
}) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Code Companion — harness</title>
<style>
${css}
</style>
</head>
<body>

<!--
  Stand-in for the aXet platform shell. The hamburger below is written
  the way a shell that does NOT use any conventional toggle class name
  would write it — which is the case the original CSS-only removal
  missed.
-->
<header class="platform-shell-header" style="display:flex;align-items:center;gap:12px;padding:10px 16px;background:#fff;border-bottom:1px solid #e2e8f0;">
  <button id="shell-hamburger" type="button" class="tb-icon-btn" aria-label="Open menu"
          style="width:34px;height:34px;border:0;background:transparent;cursor:pointer;">
    <i class="fa fa-bars" aria-hidden="true">&#9776;</i>
  </button>
  <span class="navbar-brand">SAP Code Companion</span>
  <span style="margin-left:auto;">Ummadisetti, Hariharan</span>
</header>

<div class="formio-form">

  <!--
    Sidebar panel. Best-effort reproduction of what a Form.io "container"
    holding an htmlelement plus a "datagrid" is believed to render -- the
    outer wrapper classes (.formio-component-container,
    .formio-component-sidebarPanel) are the part actually load-bearing
    for the CSS in history.css; the inner datagrid markup below is a
    plausible approximation, not a verified one (Form.io itself is not
    available in this harness). See docs/CHAT-HISTORY.md.
  -->
  <div class="formio-component formio-component-container formio-component-sidebarPanel sca-sidebar-panel">
    <div class="formio-component formio-component-htmlelement">
      <div class="sca-sidebar-header-host">
${sidebarHeaderHtml}
      </div>
    </div>

    <div class="formio-component formio-component-datagrid formio-component-conversationsGrid">
      <table>
        <thead><tr><th>Title</th><th>Updated</th><th>Open</th><th>Delete</th></tr></thead>
        <tbody id="sca-harness-conversations-body"></tbody>
      </table>
    </div>
  </div>

  <!--
    Form.io renders an htmlelement as <div class="{className}">, so the
    header host class sits on the inner div, not the component wrapper.
    Section 23 of the stylesheet is scoped with body:has(.sca-header-host),
    so getting this nesting right is what makes those rules apply.
  -->
  <div class="formio-component formio-component-htmlelement">
    <div class="sca-header-host">
${headerHtml}
    </div>
  </div>

  <div class="formio-component formio-component-htmlelement">
    <div class="sca-chat-surface-host">
${surfaceHtml}
    </div>
  </div>

  <div class="formio-component formio-component-textarea formio-component-messagesJson">
    <textarea name="data[messagesJson]">[]</textarea>
  </div>

  <div class="formio-component formio-component-textarea formio-component-attachmentsText">
    <textarea name="data[attachmentsText]"></textarea>
  </div>

  <div class="formio-component formio-component-textarea formio-component-attachmentsJson">
    <textarea name="data[attachmentsJson]">[]</textarea>
  </div>

  <div class="formio-component formio-component-container formio-component-composer sca-composer">
    <div class="formio-component formio-component-htmlelement sca-prompt-budget-host">
${budgetHtml}
    </div>

    <!--
      Best-effort reproduction of Form.io's default "file" component
      template (ref="fileDrop"/"fileBrowse", an underlying real
      <input type="file">). This is the ONE shape in this harness with
      no directly observed precedent -- see docs/CHAT-HISTORY.md -- but
      the underlying <input type="file"> and its native change event
      are standard HTML regardless of the exact wrapper markup around
      them, which is what SCA-37's delegated listener actually depends
      on.
    -->
    <div class="formio-component formio-component-container formio-component-attachmentBar sca-attachment-bar-host">
      <div class="formio-component formio-component-file formio-component-attachmentPicker">
        <div class="fileSelector" ref="fileDrop">
          <i class="fa fa-cloud-upload"></i>
          <span>Drop files to attach, or</span>
          <a href="#" ref="fileBrowse">browse</a>
          <input type="file" multiple accept=".docx,.pdf,.txt,.md,.markdown" style="opacity:0;position:absolute;inset:0;">
        </div>
        <ul ref="fileList" class="list-group"></ul>
      </div>

      <div class="formio-component formio-component-htmlelement">
${trayHostHtml}
      </div>
    </div>

    <div class="formio-component formio-component-textarea formio-component-userMessage">
      <div class="form-group">
        <textarea name="data[composer][userMessage]"
                  placeholder="Ask an SAP coding-related question..."></textarea>
      </div>
    </div>

    <div class="formio-component formio-component-button formio-component-sendMessage sca-send">
      <button type="button" name="data[sendMessage]">&#10148;</button>
    </div>
  </div>

  <div class="formio-component formio-component-button formio-component-newChat">
    <button type="button" name="data[newChat]">New Chat</button>
  </div>

  <div class="formio-component formio-component-button formio-component-downloadResponse sca-download-submit">
    <button type="button" name="data[downloadResponse]">Download</button>
  </div>

  <!--
    CSS-hidden (history.css 26F), not Form.io hidden:true — a real,
    clickable button ScaHistory.refreshConversationList() finds and
    clicks, matching the technique already used for messagesJson etc.
  -->
  <div class="formio-component formio-component-button formio-component-loadConversations">
    <button type="button" name="data[loadConversations]">Load Conversations</button>
  </div>

  <div class="formio-component formio-component-htmlelement">
    <div id="sca-browser-controller-anchor" aria-hidden="true" style="display:none !important;"></div>
  </div>

</div>

<script>
/*
 * Minimal stand-in for the Form.io instance the controller reads state
 * from. Only the surface the controller actually touches is provided.
 */
(function () {
    var formElement = document.querySelector(".formio-form");

    var submissionData = {
        messagesJson: "[]",
        attachmentsText: "",
        attachmentsJson: "[]",
        currentStage: "understand",
        agentPhase: "understand",
        processing: false,
        processingMessage: "",
        userMessage: "",
        composer: { userMessage: "" }
    };

    formElement.__formio__ = { submission: { data: submissionData } };

    /* Mirror field edits into the submission, as Form.io would. */
    document.addEventListener("input", function (event) {
        var target = event.target;
        var name = target && target.getAttribute && target.getAttribute("name");

        if (!name) {
            return;
        }

        var match = /^data\\[([^\\]]+)\\](?:\\[([^\\]]+)\\])?$/.exec(name);

        if (!match) {
            return;
        }

        if (match[2]) {
            submissionData[match[1]] = submissionData[match[1]] || {};
            submissionData[match[1]][match[2]] = target.value;
        } else {
            submissionData[match[1]] = target.value;
        }
    }, true);

    /* Records what a real submit would have carried away. */
    window.__harnessSubmissions = [];

    /*
     * Bubble phase, deliberately: the controller's capture-phase handler
     * runs first and writes the attachment fields, so by the time the
     * event reaches here the submission looks exactly as Form.io would
     * read it. The button is disabled by then (the turn is in flight),
     * so its state is not a useful filter.
     */
    document.addEventListener("click", function (event) {
        if (event.target.closest('button[name="data[sendMessage]"]')) {
            window.__harnessSubmissions.push(
                JSON.parse(JSON.stringify(submissionData))
            );
        }
    }, false);

    window.__harnessData = submissionData;
    window.data = submissionData;

    /*
     * Minimal reproduction of Form.io re-rendering a datagrid from a
     * bound array — enough to test this project's OWN CSS and the one
     * behaviour (closing the sidebar after a row is opened, on narrow
     * screens) that depends on the row buttons' class names. It is not
     * a claim about how Form.io itself renders a datagrid.
     */
    window.__harnessRenderConversations = function (rows) {
        submissionData.conversationsGrid = rows;

        var body = document.getElementById("sca-harness-conversations-body");

        body.innerHTML = "";

        rows.forEach(function (row, index) {
            var tr = document.createElement("tr");

            tr.innerHTML =
                '<td class="formio-component formio-component-title">' +
                row.title +
                '</td><td class="formio-component formio-component-updatedAtLabel">' +
                row.updatedAtLabel +
                '</td><td class="formio-component formio-component-open">' +
                '<button type="button">open</button></td>' +
                '<td class="formio-component formio-component-delete">' +
                '<button type="button">delete</button></td>';

            tr.querySelector(".formio-component-open button").addEventListener(
                "click",
                function () {
                    submissionData.conversationsGrid.forEach(function (r) {
                        r.open = false;
                    });
                    submissionData.conversationsGrid[index].open = true;
                }
            );

            tr.querySelector(".formio-component-delete button").addEventListener(
                "click",
                function () {
                    submissionData.conversationsGrid.forEach(function (r) {
                        r["delete"] = false;
                    });
                    submissionData.conversationsGrid[index]["delete"] = true;
                }
            );

            body.appendChild(tr);
        });
    };
})();
</script>

<script>
${controller}
</script>

</body>
</html>
`;
}

main();
