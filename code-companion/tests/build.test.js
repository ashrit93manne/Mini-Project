/*
 * The build must be reproducible.
 *
 * Everything about reviewing this project rests on being able to ask
 * "did anything actually change?" of a generated 950 KB JSON file. If
 * two builds of identical sources differ, that question has no answer
 * and diff_export's output stops meaning anything.
 *
 * Run: node tests/build.test.js
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

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

function build(outPath) {
    execFileSync(
        "python3",
        [
            path.join(ROOT, "tools", "build_deptapp.py"),
            "--base",
            path.join(
                ROOT,
                "baseline",
                "aXet.SAP__Code_Companion_v5.1.0_RAG.deptapp"
            ),
            "--pristine",
            path.join(
                ROOT,
                "baseline",
                "aXet.SAP__Code_Agents_v4.6.2_export.deptapp"
            ),
            "--out",
            outPath
        ],
        { cwd: ROOT, stdio: "pipe" }
    );

    return crypto
        .createHash("sha1")
        .update(fs.readFileSync(outPath))
        .digest("hex");
}

function main() {
    console.log("\nBuild reproducibility");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sca-build-"));

    const first = build(path.join(dir, "one.deptapp"));
    const second = build(path.join(dir, "two.deptapp"));

    check(
        "two builds of the same sources are byte-identical",
        first === second,
        first + "\n" + second
    );

    /*
     * The build is defined as "v5.1.0 baseline + pristine v4.6.2
     * sources". Running it over its OWN output is a mistake — the
     * anchored patches have already been applied — and it must say so
     * rather than half-apply and produce something subtly wrong.
     */
    let overBuildFailed = false;
    let overBuildMessage = "";

    try {
        execFileSync(
            "python3",
            [
                path.join(ROOT, "tools", "build_deptapp.py"),
                "--base",
                path.join(dir, "one.deptapp"),
                "--pristine",
                path.join(
                    ROOT,
                    "baseline",
                    "aXet.SAP__Code_Agents_v4.6.2_export.deptapp"
                ),
                "--out",
                path.join(dir, "again.deptapp")
            ],
            { cwd: ROOT, stdio: "pipe" }
        );
    } catch (error) {
        overBuildFailed = true;
        overBuildMessage = String(error.stderr || error.message);
    }

    check(
        "building over an already-built export is refused",
        overBuildFailed,
        "it silently produced an output instead"
    );

    check(
        "and it says why, rather than dumping a traceback",
        /BUILD FAILED/.test(overBuildMessage),
        overBuildMessage.split("\n").slice(-3).join("\n")
    );

    check(
        "no half-built artefact is left behind",
        !fs.existsSync(path.join(dir, "again.deptapp"))
    );

    fs.rmSync(dir, { recursive: true, force: true });

    console.log("\n" + passed + " passed, " + failed + " failed");

    process.exit(failed === 0 ? 0 : 1);
}

main();
