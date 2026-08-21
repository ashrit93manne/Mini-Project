/*
 * Builds tests/harness/index.html from the BUILT .deptapp.
 *
 * The harness renders the export's real `formStructure` through the real
 * Form.io renderer (formiojs, a devDependency). Nothing about the form's
 * DOM is written by hand here.
 *
 * That is a deliberate correction. Until v5.2.0 this file hand-authored
 * an approximation of Form.io's markup for the `file` and `datagrid`
 * components, and every stylesheet rule and controller routine aimed at
 * those components was written and validated against that approximation.
 * The approximation was wrong in ways that mattered:
 *
 *   - it gave the file component a persistent <input type="file">.
 *     Real Form.io has none: File.browseFiles() creates a transient
 *     input on document.body, clicks it, and removes it again on
 *     change. A delegated listener bound to an input "inside" the
 *     component therefore never fires, which is why file upload was
 *     completely dead in production.
 *   - it rendered an empty <ul ref="fileList">. Real Form.io always
 *     renders <ul class="list-group"> (no ref) carrying a
 *     <li class="list-group-header"> with "File Name" and "Size",
 *     whether or not any file is attached.
 *   - it rendered zero datagrid rows for an empty value. Real Form.io
 *     materialises one blank row regardless of `defaultValue: []`.
 *
 * The controller is evaluated BEFORE the form is rendered, because that
 * is the order the platform uses: the customjs component is evaluated on
 * the form's data lifecycle, which starts before the components have
 * painted. Running it after render was the other half of the old
 * harness's fiction — it let DOM decoration appear to work when in
 * production it never ran against anything.
 */

const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ROOT = path.join(HERE, "..", "..");

const APP_NODE_ID = "5439b0c95ce6e66d";
const FORM_NODE_ID = "21d415924e0e4841";

const DEFAULT_EXPORT = "aXet.SAP__Code_Companion_v5.2.0_export.deptapp";

function main() {
    const exportPath =
        process.argv[2] || path.join(ROOT, "build", DEFAULT_EXPORT);

    const data = JSON.parse(fs.readFileSync(exportPath, "utf8"));
    const flows = data.flowsData.flows;
    const byId = Object.fromEntries(flows.map((node) => [node.id, node]));

    const css = byId[APP_NODE_ID].customCSS;
    const form = byId[FORM_NODE_ID];
    const components = form.formStructure.components;

    const controller = findNested(components, "serverSideJavaScript").content;

    assertFormioAvailable();

    const page = renderPage({
        css,
        controller,
        formStructure: form.formStructure
    });

    fs.writeFileSync(path.join(HERE, "index.html"), page, "utf8");

    console.log(
        "harness written (controller " +
            controller.length.toLocaleString() +
            " chars, css " +
            css.length.toLocaleString() +
            " chars, " +
            components.length +
            " components rendered by real Form.io)"
    );
}

function assertFormioAvailable() {
    const dist = path.join(
        ROOT,
        "node_modules",
        "formiojs",
        "dist",
        "formio.full.min.js"
    );

    if (!fs.existsSync(dist)) {
        throw new Error(
            "formiojs is not installed. The harness renders the real " +
                "Form.io DOM rather than a hand-written approximation of " +
                "it; run `npm install` first."
        );
    }
}

function findNested(components, key) {
    for (const component of components) {
        if (component.key === key) {
            return component;
        }

        for (const list of nestedLists(component)) {
            const found = findNested(list, key);

            if (found) {
                return found;
            }
        }
    }

    return null;
}

function* nestedLists(component) {
    if (Array.isArray(component.components)) {
        yield component.components;
    }

    if (Array.isArray(component.columns)) {
        for (const column of component.columns) {
            if (column && Array.isArray(column.components)) {
                yield column.components;
            }
        }
    }
}

/* Keeps an inlined JSON payload from closing the surrounding script. */
function inlineJson(value) {
    return JSON.stringify(value).replace(/<\//g, "<\\/");
}

function renderPage({ css, controller, formStructure }) {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Code Companion — harness</title>
<link rel="stylesheet" href="../../node_modules/formiojs/dist/formio.full.min.css">
<style>
${css}
</style>
</head>
<body>

<!--
  Stand-in for the aXet platform shell. The hamburger below is written
  the way a shell that does NOT use any conventional toggle class name
  would write it — which is the case the original CSS-only removal
  missed. This is the only hand-written markup in the harness, and it is
  deliberately outside .formio-form: the application never renders it.
-->
<header class="platform-shell-header" style="display:flex;align-items:center;gap:12px;padding:10px 16px;background:#fff;border-bottom:1px solid #e2e8f0;">
  <button id="shell-hamburger" type="button" class="tb-icon-btn" aria-label="Open menu"
          style="width:34px;height:34px;border:0;background:transparent;cursor:pointer;">
    <i class="fa fa-bars" aria-hidden="true">&#9776;</i>
  </button>
  <span class="navbar-brand">SAP Code Companion</span>
  <span style="margin-left:auto;">Ummadisetti, Hariharan</span>
</header>

<div id="formio-host"></div>

<script src="../../node_modules/formiojs/dist/formio.full.min.js"></script>
<script id="sca-controller">
${controller}
</script>
<script>
/*
 * Order matters and is deliberate — see the file header. The controller
 * script above has already run by the time Form.io is asked to render.
 */
(function () {
    var FORM_STRUCTURE = ${inlineJson(formStructure)};

    window.__harnessErrors = [];

    window.addEventListener("error", function (event) {
        window.__harnessErrors.push(String(event.message));
    });

    Formio.createForm(document.getElementById("formio-host"), FORM_STRUCTURE, {
        noAlerts: true
    }).then(function (form) {
        window.__harnessForm = form;
        window.__harnessData = form.submission.data;

        /*
         * The platform exposes the live Form.io instance on the form
         * element; the application's own controller (written by the
         * original team, and working in production) reads state through
         * exactly this handle.
         */
        var element = document.querySelector(".formio-form");

        if (element) {
            element.__formio__ = form;
        }

        /* Records what a real submit would have carried away. */
        window.__harnessSubmissions = [];

        /*
         * Capture phase, not bubble. Form.io's own button handler calls
         * stopPropagation(), so a bubble listener on document never sees
         * a send click at all — the old hand-written harness used bubble
         * and only worked because its buttons were plain markup with no
         * Form.io handler on them.
         *
         * Capture still gives the ordering this needs: the controller
         * registers its own capture listener at boot, before this one, so
         * it has already written the attachment fields by the time the
         * snapshot below is taken.
         */
        document.addEventListener(
            "click",
            function (event) {
                /*
                 * Matched on the component class, not on
                 * name="data[sendMessage]". Real Form.io nests a
                 * button's name under its container, so the send
                 * button is actually name="data[composer][sendMessage]"
                 * — the old hand-written harness got this wrong too.
                 */
                if (
                    event.target.closest(
                        ".formio-component-sendMessage button"
                    )
                ) {
                    window.__harnessSubmissions.push(
                        JSON.parse(JSON.stringify(form.submission.data))
                    );
                }
            },
            true
        );

        /*
         * Puts a file through the component's real value channel: the
         * shape below is exactly what formiojs' base64 storage provider
         * resolves to (providers/storage/base64.js), which is what the
         * platform stores in the submission.
         */
        window.__harnessAttach = function (name, mime, base64) {
            var picker = form.getComponent("attachmentPicker");

            if (!picker) {
                throw new Error("attachmentPicker component not found");
            }

            var existing = Array.isArray(picker.dataValue)
                ? picker.dataValue.slice()
                : [];

            existing.push({
                storage: "base64",
                name: name,
                originalName: name,
                url: "data:" + mime + ";base64," + base64,
                size: Math.round((base64.length * 3) / 4),
                type: mime
            });

            picker.setValue(existing, { modified: true });
            form.triggerChange();

            return existing.length;
        };

        window.__harnessAttachedNames = function () {
            var picker = form.getComponent("attachmentPicker");
            var value = picker && picker.dataValue;

            return (Array.isArray(value) ? value : []).map(function (file) {
                return file.name;
            });
        };

        /* Drives the conversation list through the real datagrid value. */
        window.__harnessSetConversations = function (rows) {
            var grid = form.getComponent("conversationsGrid");

            if (!grid) {
                throw new Error("conversationsGrid component not found");
            }

            grid.setValue(rows, { modified: true });
            form.triggerChange();

            return grid.dataValue.length;
        };

        window.__harnessReady = true;
    });
})();
</script>

</body>
</html>
`;
}

main();
