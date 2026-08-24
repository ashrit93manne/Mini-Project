/*
 * The conversation owner has to survive the trip from the browser to
 * the flow.
 *
 * This exists because of a contract that is invisible from the JSON:
 * a Form.io `hidden` component does NOT pick up a value written to its
 * input element, while a `textarea` does. The controller's
 * setFormField() writes the DOM value and dispatches input/change —
 * which is exactly how messagesJson, attachmentsText and every other
 * state field already reach the backend — and on a `hidden` component
 * that does nothing at all. The field looks correct in the DOM and the
 * submission stays empty.
 *
 * Run against a harness built from the v5.5.0 export:
 *   node tests/harness/build-harness.js build/aXet.SAP__Code_Companion_v5.5.0_export.deptapp
 *   node tests/owner-browser.test.js
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const HARNESS = path.join(__dirname, "harness", "index.html");

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
    if (condition) {
        passed += 1;
        console.log("  PASS  " + name);
        return;
    }

    failed += 1;
    console.log("  FAIL  " + name);

    if (detail !== undefined) {
        console.log("        " + String(detail).split("\n").join("\n        "));
    }
}

async function main() {
    if (!fs.existsSync(HARNESS)) {
        console.error("harness missing");
        process.exit(1);
    }

    const browser = await chromium.launch({
        executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
        args: ["--no-sandbox"]
    });

    const page = await browser.newPage({
        viewport: { width: 1440, height: 900 }
    });

    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await page.goto("file://" + HARNESS);
    await page.waitForFunction(() => window.__harnessReady === true, null, {
        timeout: 20000
    });
    await page.waitForTimeout(2500);

    console.log("\nSCA-40 — the conversation owner reaches the flow");

    check("no page errors", pageErrors.length === 0, pageErrors.join("\n"));

    const state = await page.evaluate(() => {
        const form = window.__harnessForm;
        const component = form.getComponent("conversationOwner");

        return {
            declared: Boolean(component),
            type: component && component.component && component.component.type,
            dom: (
                document.querySelector('[name="data[conversationOwner]"]') || {}
            ).value,
            submission: form.submission.data.conversationOwner
        };
    });

    check("the field is declared on the form", state.declared, JSON.stringify(state));

    check(
        "it is a component type that binds from setFormField",
        state.type !== "hidden",
        "type is '" +
            state.type +
            "' — a hidden component ignores DOM writes, so the value " +
            "never reaches the submission"
    );

    check(
        "the browser resolved an owner",
        Boolean(state.dom),
        JSON.stringify(state)
    );

    check(
        "and the flow will actually receive it",
        Boolean(state.submission) && state.submission === state.dom,
        "dom=" +
            JSON.stringify(state.dom) +
            " submission=" +
            JSON.stringify(state.submission)
    );

    /*
     * The value must be stable: a different owner on each render would
     * scatter one person's conversations across several histories.
     */
    const again = await page.evaluate(async () => {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return window.__harnessForm.submission.data.conversationOwner;
    });

    check(
        "the owner is stable across renders",
        again === state.submission,
        JSON.stringify(state.submission) + " -> " + JSON.stringify(again)
    );

    await browser.close();

    console.log("\n" + passed + " passed, " + failed + " failed");
    process.exit(failed === 0 ? 0 : 1);
}

main();
