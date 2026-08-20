/*
 * Tests for the conversation-history backend functions, run against the
 * code inside the BUILT .deptapp — the same technique as
 * tests/backend.test.js.
 *
 * What this suite can and cannot verify
 * --------------------------------------
 * It fully verifies: title/relative-time computation, defensive
 * reshaping of malformed or missing query/find-one results, the
 * conversationId-as-upsert-key design, and that a loaded conversation
 * lands in the exact shape the existing chat-render pipeline expects.
 *
 * It CANNOT verify the one thing that actually depends on the real
 * platform: what shape nosql-query/nosql-find-one/nosql-persist bind
 * onto msg.submission/msg.payload against a REAL database. Every test
 * here that touches that boundary exercises BOTH plausible shapes
 * (flat documents and {_id, data:{...}} envelopes) to confirm the
 * reshaping functions handle either — but "handles either shape
 * gracefully" is not the same claim as "matches the real one". See
 * docs/CHAT-HISTORY.md.
 *
 * Run: node tests/history-backend.test.js
 */

const fs = require("fs");
const path = require("path");

const EXPORT = path.join(
    __dirname,
    "..",
    "build",
    "aXet.SAP__Code_Agents_v5.0.0_export.deptapp"
);

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

function section(title) {
    console.log("\n" + title);
}

function makeRuntime() {
    const warnings = [];
    const flowStore = {};

    return {
        warnings,
        node: {
            warn: (entry) => warnings.push(entry),
            error: (entry) => warnings.push({ level: "error", entry }),
            status: () => {},
            send: () => {},
            done: () => {}
        },
        flow: {
            get: (key) => flowStore[key],
            set: (key, value) => {
                flowStore[key] = value;
            }
        },
        context: { get: () => undefined, set: () => {} },
        env: { get: () => undefined },
        util: {}
    };
}

function loadNodes() {
    const data = JSON.parse(fs.readFileSync(EXPORT, "utf8"));
    const byName = {};

    for (const node of data.flowsData.flows) {
        if (node.type === "function" && !(node.name in byName)) {
            byName[node.name] = node;
        }
    }

    return byName;
}

function runNode(nodeDefinition, msg) {
    const runtime = makeRuntime();

    const body = new Function(
        "msg",
        "node",
        "flow",
        "context",
        "env",
        "util",
        nodeDefinition.func
    );

    const result = body(
        msg,
        runtime.node,
        runtime.flow,
        runtime.context,
        runtime.env,
        runtime.util
    );

    return { result, warnings: runtime.warnings };
}

/* =========================================================
 * Prepare Conversation Persist
 * ========================================================= */

function testPreparePersist(nodes) {
    const node = nodes["Prepare Conversation Persist"];

    section("Prepare Conversation Persist");

    const history = [
        { role: "user", content: "Build a RAP service for sales orders." },
        { role: "assistant", content: "Here is the implementation..." }
    ];

    const run = runNode(node, {
        payload: {
            data: {
                messagesJson: JSON.stringify(history),
                currentStage: "code",
                conversationId: "sap-existing-id"
            }
        }
    });

    check("an existing conversation is not routed away", run.result !== null);

    check(
        "the document is addressed by the existing conversation id",
        run.result.submission._id === "sap-existing-id",
        run.result.submission._id
    );

    check(
        "the title is taken from the first user message",
        run.result.submission.data.title === "Build a RAP service for sales orders.",
        run.result.submission.data.title
    );

    check(
        "the full messagesJson travels with the document",
        run.result.submission.data.messagesJson === JSON.stringify(history)
    );

    check(
        "updatedAt is a real timestamp",
        !isNaN(new Date(run.result.submission.data.updatedAt).getTime())
    );

    section("Prepare Conversation Persist — first message of a session");

    const fresh = runNode(node, {
        payload: {
            data: {
                messagesJson: JSON.stringify([
                    { role: "user", content: "What is RAP?" },
                    { role: "assistant", content: "RAP is..." }
                ]),
                currentStage: "understand",
                conversationId: ""
            }
        }
    });

    check(
        "a missing conversation id is generated rather than left empty",
        typeof fresh.result.submission._id === "string" &&
            fresh.result.submission._id.length > 0,
        fresh.result.submission._id
    );

    check(
        "the generated id is written back for the client to persist",
        fresh.result.payload &&
            fresh.result.payload.data &&
            fresh.result.payload.data.conversationId === fresh.result.submission._id,
        JSON.stringify(fresh.result.payload)
    );

    section("Prepare Conversation Persist — nothing to save yet");

    const empty = runNode(node, {
        payload: { data: { messagesJson: "[]", conversationId: "" } }
    });

    check(
        "an empty conversation produces no document",
        empty.result === null,
        JSON.stringify(empty.result)
    );

    section("Prepare Conversation Persist — long first message");

    const longTitle = runNode(node, {
        payload: {
            data: {
                messagesJson: JSON.stringify([
                    {
                        role: "user",
                        content:
                            "This is a very long first message that goes well beyond sixty characters and should be shortened for the sidebar title."
                    }
                ]),
                conversationId: "sap-long"
            }
        }
    });

    check(
        "a long first message is truncated to a sidebar-sized title",
        longTitle.result.submission.data.title.length <= 60,
        longTitle.result.submission.data.title
    );

    check(
        "the truncated title ends with an ellipsis",
        longTitle.result.submission.data.title.endsWith("..."),
        longTitle.result.submission.data.title
    );
}

/* =========================================================
 * Prepare Conversation List Query
 * ========================================================= */

function testPrepareListQuery(nodes) {
    const node = nodes["Prepare Conversation List Query"];

    section("Prepare Conversation List Query");

    const run = runNode(node, {
        __axetFlowsSecurityContext: { userid: "hariharan.ummadisetti@nttdata.com" }
    });

    check(
        "the filter carries the current user's id",
        run.result.submission.searchFilterContainer.userId ===
            "hariharan.ummadisetti@nttdata.com",
        JSON.stringify(run.result.submission)
    );

    check(
        "a page size is always supplied",
        run.result.submission.paginator.itemsPerPage > 0,
        run.result.submission.paginator
    );

    const anonymous = runNode(node, {});

    check(
        "a request with no identifiable user still produces a usable filter",
        typeof anonymous.result.submission.searchFilterContainer.userId === "string" &&
            anonymous.result.submission.searchFilterContainer.userId.length > 0,
        JSON.stringify(anonymous.result.submission)
    );
}

/* =========================================================
 * Apply Conversation List
 * ========================================================= */

function testApplyConversationList(nodes) {
    const node = nodes["Apply Conversation List"];

    section("Apply Conversation List — flat document shape");

    const flat = runNode(node, {
        submission: {
            conversationsRaw: [
                {
                    _id: "sap-1",
                    title: "Older conversation",
                    updatedAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString()
                },
                {
                    _id: "sap-2",
                    title: "Newest conversation",
                    updatedAt: new Date().toISOString()
                }
            ]
        }
    });

    const flatRows = flat.result.payload.data.conversationsGrid;

    check("both documents became rows", flatRows.length === 2, flatRows.length);

    check(
        "rows are sorted newest first",
        flatRows[0]._id === "sap-2" && flatRows[1]._id === "sap-1",
        JSON.stringify(flatRows.map((r) => r._id))
    );

    check(
        "each row starts with both action flags off",
        flatRows.every((row) => row.open === false && row["delete"] === false)
    );

    section("Apply Conversation List — {_id, data:{...}} envelope shape");

    const enveloped = runNode(node, {
        submission: {
            conversationsRaw: [
                {
                    _id: "sap-3",
                    data: { title: "Enveloped conversation", updatedAt: new Date().toISOString() }
                }
            ]
        }
    });

    const envelopedRows = enveloped.result.payload.data.conversationsGrid;

    check(
        "the envelope shape is also read correctly",
        envelopedRows.length === 1 && envelopedRows[0].title === "Enveloped conversation",
        JSON.stringify(envelopedRows)
    );

    section("Apply Conversation List — defensive cases");

    const missing = runNode(node, { submission: {} });

    check(
        "a missing result list produces an empty (not broken) sidebar",
        Array.isArray(missing.result.payload.data.conversationsGrid) &&
            missing.result.payload.data.conversationsGrid.length === 0
    );

    const malformed = runNode(node, {
        submission: { conversationsRaw: [null, {}, { _id: "sap-4" }, "not an object"] }
    });

    check(
        "malformed entries are dropped rather than crashing the function",
        malformed.result.payload.data.conversationsGrid.length === 1 &&
            malformed.result.payload.data.conversationsGrid[0]._id === "sap-4",
        JSON.stringify(malformed.result.payload.data.conversationsGrid)
    );

    check(
        "a document with no title falls back to a placeholder",
        malformed.result.payload.data.conversationsGrid[0].title ===
            "Untitled conversation",
        malformed.result.payload.data.conversationsGrid[0].title
    );
}

/* =========================================================
 * Get Selected / Delete Conversation Id
 * ========================================================= */

function testRowIdExtraction(nodes) {
    section("Get Selected Conversation Id");

    const getSelected = nodes["Get Selected Conversation Id"];

    const picked = runNode(getSelected, {
        submission: {
            conversationsGrid: [
                { _id: "sap-1", open: false },
                { _id: "sap-2", open: true },
                { _id: "sap-3", open: false }
            ]
        }
    });

    check("the open row's id is extracted", picked.result._id === "sap-2", picked.result._id);

    const noneOpen = runNode(getSelected, {
        submission: { conversationsGrid: [{ _id: "sap-1", open: false }] }
    });

    check(
        "no selection routes nowhere rather than crashing",
        noneOpen.result === null,
        JSON.stringify(noneOpen.result)
    );

    section("Get Delete Conversation Id");

    const getDelete = nodes["Get Delete Conversation Id"];

    const deletePicked = runNode(getDelete, {
        submission: {
            conversationsGrid: [
                { _id: "sap-1", "delete": false },
                { _id: "sap-2", "delete": true }
            ]
        }
    });

    check(
        "the delete row's id is extracted",
        deletePicked.result._id === "sap-2",
        deletePicked.result._id
    );
}

/* =========================================================
 * Apply Loaded Conversation
 * ========================================================= */

function testApplyLoadedConversation(nodes) {
    const node = nodes["Apply Loaded Conversation"];

    section("Apply Loaded Conversation — found");

    const history = [{ role: "user", content: "Hi" }];

    const run = runNode(node, {
        _id: "sap-7",
        payload: {
            data: {
                data: {
                    messagesJson: JSON.stringify(history),
                    currentStage: "validate"
                }
            }
        }
    });

    check(
        "the conversation id is carried into the restored state",
        run.result.payload.data.conversationId === "sap-7",
        run.result.payload.data.conversationId
    );

    check(
        "the transcript is restored exactly",
        run.result.payload.data.messagesJson === JSON.stringify(history)
    );

    check(
        "the stage is restored",
        run.result.payload.data.currentStage === "validate"
    );

    check(
        "a loaded conversation carries no leftover attachment",
        run.result.payload.data.attachmentsText === "" &&
            run.result.payload.data.attachmentsJson === "[]"
    );

    check(
        "processing is cleared so the composer is immediately usable",
        run.result.payload.data.processing === false
    );

    section("Apply Loaded Conversation — deleted / not found");

    const notFound = runNode(node, {
        _id: "sap-missing",
        payload: { data: {} }
    });

    check(
        "a missing conversation produces a user-facing error, not a crash",
        typeof notFound.result.payload.data.uiError === "string" &&
            notFound.result.payload.data.uiError.length > 0,
        JSON.stringify(notFound.result.payload)
    );

    section("Apply Loaded Conversation — flat (non-enveloped) result shape");

    const flatShape = runNode(node, {
        _id: "sap-8",
        payload: {
            data: {
                messagesJson: JSON.stringify(history),
                currentStage: "code"
            }
        }
    });

    check(
        "the flat shape is also handled",
        flatShape.result.payload.data.messagesJson === JSON.stringify(history) &&
            flatShape.result.payload.data.currentStage === "code",
        JSON.stringify(flatShape.result.payload)
    );
}

/* =========================================================
 * Runner
 * ========================================================= */

(function run() {
    console.log("Code Companion — conversation history backend tests\n");

    if (!fs.existsSync(EXPORT)) {
        console.error("built export missing — run tools/build_deptapp.py first");
        process.exit(1);
    }

    const nodes = loadNodes();

    try {
        testPreparePersist(nodes);
        testPrepareListQuery(nodes);
        testApplyConversationList(nodes);
        testRowIdExtraction(nodes);
        testApplyLoadedConversation(nodes);
    } catch (error) {
        console.error("\nTest run aborted:", error);
        process.exit(1);
    }

    console.log("\n" + passed + " passed, " + failed + " failed");

    process.exit(failed === 0 ? 0 : 1);
})();
