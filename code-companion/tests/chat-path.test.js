/*
 * The chat path: does a sent prompt reach the model, and does a
 * conversation exist afterwards?
 *
 * Both of these broke in v5.4.0, and both broke silently — the screen
 * simply sat on "Working on it..." forever with an empty sidebar.
 *
 * The contracts below are taken from the v4.6.2 baseline, which is the
 * only version of this application known to have answered a prompt in
 * production. Where v5.4.0 and the baseline disagree about what the
 * Enabler node is given, the baseline wins: it is evidence, and the
 * comment in v5.4.0 that replaced it ("Enabler accepts msg.messages OR
 * msg.query") is an assumption.
 *
 * Run: node tests/chat-path.test.js
 */

const fs = require("fs");
const path = require("path");

const EXPORT = path.join(
    __dirname,
    "..",
    "build",
    "aXet.SAP__Code_Companion_v5.5.0_export.deptapp"
);

const BASELINE = path.join(
    __dirname,
    "..",
    "baseline",
    "aXet.SAP__Code_Agents_v4.6.2_export.deptapp"
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

function loadNodes(file) {
    const byName = {};

    for (const node of JSON.parse(fs.readFileSync(file, "utf8")).flowsData
        .flows) {
        if (node.type === "function" && !(node.name in byName)) {
            byName[node.name] = node;
        }
    }

    return byName;
}

/*
 * `require` is deliberately NOT provided: a Node-RED function sandbox
 * does not define it unless the deployment enables external modules,
 * and the chat path must not depend on that being configured.
 */
function run(node, msg) {
    const warnings = [];
    const errors = [];
    const store = {};

    const runtime = {
        warn: (entry) => warnings.push(entry),
        error: (entry) => errors.push(String(entry)),
        status: () => {},
        send: () => {},
        done: () => {}
    };

    const body = new Function(
        "msg",
        "node",
        "flow",
        "context",
        "env",
        "util",
        node.func
    );

    try {
        return {
            result: body(
                msg,
                runtime,
                {
                    get: (key) => store[key],
                    set: (key, value) => {
                        store[key] = value;
                    }
                },
                { get: () => undefined, set: () => {} },
                { get: () => undefined },
                {}
            ),
            warnings,
            errors
        };
    } catch (error) {
        return { threw: error, warnings, errors };
    }
}

function firstMessage(result) {
    if (Array.isArray(result)) {
        return result.find((entry) => entry) || null;
    }

    return result || null;
}

const QUESTION = "Which SAP tables are recommended for the report?";

function sendMsg(overrides) {
    return {
        payload: { data: {} },
        submission: {
            data: Object.assign(
                {
                    composer: { userMessage: QUESTION },
                    messagesJson: JSON.stringify([
                        {
                            id: "greeting",
                            role: "assistant",
                            content: "Hello! I'm your SAP Code Companion."
                        }
                    ]),
                    attachmentsText: "",
                    attachmentsJson: "[]",
                    currentStage: "understand",
                    agentPhase: "understand",
                    conversationId: "sap-mfvz9k3q-a1b2c3d4"
                },
                overrides || {}
            )
        },
        __deptAppsFormioButtonClicked: "sendMessage"
    };
}

function main() {
    if (!fs.existsSync(EXPORT)) {
        console.error("built export missing — run npm run build:v55 first");
        process.exit(1);
    }

    const nodes = loadNodes(EXPORT);
    const baselineNodes = loadNodes(BASELINE);

    /* ===================================================== */
    section("The Enabler input contract");

    const baselineOut = firstMessage(
        run(baselineNodes["Validate + Build SAP Agent Prompt"], sendMsg())
            .result
    );

    check(
        "the v4.6.2 baseline sends the question as msg.query",
        typeof baselineOut.query === "string" &&
            baselineOut.query.indexOf("SAP tables") !== -1,
        JSON.stringify(baselineOut.query)
    );

    const validated = run(
        nodes["Validate + Build SAP Agent Prompt"],
        sendMsg()
    );

    const afterValidate = firstMessage(validated.result);

    check(
        "the prompt builder accepts the question",
        Boolean(afterValidate),
        validated.threw && validated.threw.message
    );

    check(
        "it sets msg.query, the same as the baseline",
        Boolean(afterValidate) &&
            typeof afterValidate.query === "string" &&
            afterValidate.query.indexOf("SAP tables") !== -1,
        JSON.stringify(afterValidate && afterValidate.query)
    );

    const enabler = run(
        nodes["Prepare Enabler Request"],
        JSON.parse(JSON.stringify(afterValidate))
    );

    const toModel = firstMessage(enabler.result);

    check(
        "the preflight passes the message on",
        Boolean(toModel),
        enabler.errors.join(" | ")
    );

    check(
        "msg.query survives the preflight and reaches the model",
        Boolean(toModel) &&
            typeof toModel.query === "string" &&
            toModel.query.indexOf("SAP tables") !== -1,
        JSON.stringify(toModel && toModel.query)
    );

    check(
        "msg.messages is still a valid structured request",
        Boolean(toModel) &&
            Array.isArray(toModel.messages) &&
            toModel.messages.length >= 2 &&
            toModel.messages.every(
                (entry) =>
                    (entry.role === "system" || entry.role === "user") &&
                    typeof entry.content === "string" &&
                    entry.content.trim() !== ""
            ),
        JSON.stringify(
            toModel && toModel.messages && toModel.messages.map((m) => m.role)
        )
    );

    /* ===================================================== */
    section("A conversation exists from the first prompt");

    const persist = nodes["Prepare Conversation Persist"];

    /*
     * As it arrives in production: the browser has already written the
     * conversationOwner field (SCA-40) by the time a prompt is sent.
     */
    const sentTurn = JSON.parse(JSON.stringify(afterValidate));
    sentTurn.submission.data.conversationOwner = "ummadisetti-hariharan";

    const atSend = run(persist, sentTurn);

    const persisted = firstMessage(atSend.result);

    check(
        "sending the first prompt produces a conversation to store",
        Boolean(persisted),
        "returned null — " +
            atSend.warnings
                .map((entry) => JSON.stringify(entry))
                .join(" | ")
                .slice(0, 200)
    );

    check(
        "it is keyed by the conversation the user is in",
        Boolean(persisted) &&
            persisted.submission &&
            persisted.submission._id === "sap-mfvz9k3q-a1b2c3d4",
        JSON.stringify(persisted && persisted.submission && persisted.submission._id)
    );

    check(
        "its title comes from the user's own question, not the greeting",
        Boolean(persisted) &&
            /SAP tables/i.test(
                (persisted.submission.data &&
                    persisted.submission.data.title) ||
                    ""
            ),
        JSON.stringify(
            persisted &&
                persisted.submission.data &&
                persisted.submission.data.title
        )
    );

    check(
        "the stored history already contains the user's turn",
        (() => {
            if (!persisted) return false;
            let history = [];
            try {
                history = JSON.parse(
                    persisted.submission.data.messagesJson || "[]"
                );
            } catch (error) {
                return false;
            }
            return history.some(
                (entry) =>
                    entry.role === "user" &&
                    String(entry.content).indexOf("SAP tables") !== -1
            );
        })(),
        JSON.stringify(
            persisted && persisted.submission.data.messagesJson
        ).slice(0, 200)
    );

    /* ===================================================== */
    section("Conversation ownership");

    /*
     * v5.4.0's privacy rule, kept deliberately: with no identity from
     * the flow AND none from the browser, there is no way to separate
     * one person's history from another's, so nothing is written. That
     * is a different outcome from silently pooling everyone together.
     */
    const anonymous = run(
        persist,
        JSON.parse(JSON.stringify(afterValidate))
    );

    check(
        "with no identity at all, nothing is pooled into a shared history",
        firstMessage(anonymous.result) === null,
        JSON.stringify(
            firstMessage(anonymous.result) &&
                firstMessage(anonymous.result).submission
        ).slice(0, 160)
    );

    const owned = firstMessage(
        run(
            persist,
            JSON.parse(
                JSON.stringify(
                    Object.assign({}, afterValidate, {
                        submission: {
                            data: Object.assign(
                                {},
                                afterValidate.submission.data,
                                { conversationOwner: "hariharan.ummadisetti" }
                            )
                        }
                    })
                )
            )
        ).result
    );

    check(
        "an owner supplied by the browser is honoured",
        Boolean(owned) &&
            owned.submission.data.userId === "hariharan.ummadisetti",
        JSON.stringify(owned && owned.submission.data.userId)
    );

    check(
        "conversations are never filed under a shared 'anonymous'",
        !persisted ||
            String(persisted.submission.data.userId || "")
                .toLowerCase() !== "anonymous",
        JSON.stringify(persisted && persisted.submission.data.userId)
    );

    /* ===================================================== */
    section("The sidebar looks for conversations under the same owner");

    /*
     * Persisting under one owner and listing under another is the
     * quietest possible failure: everything appears to work, and the
     * sidebar just stays empty. The two must agree.
     */
    const listQuery = run(nodes["Prepare Conversation List Query"], {
        payload: { data: {} },
        submission: {
            data: {
                conversationOwner: "ummadisetti-hariharan",
                conversationId: "sap-mfvz9k3q-a1b2c3d4"
            }
        }
    });

    const listed = firstMessage(listQuery.result);

    check(
        "the list query is built",
        Boolean(listed),
        listQuery.threw && listQuery.threw.message
    );

    check(
        "it searches under the owner the browser supplied",
        Boolean(listed) &&
            JSON.stringify(listed.submission.searchFilterContainer).indexOf(
                "ummadisetti-hariharan"
            ) !== -1,
        JSON.stringify(listed && listed.submission.searchFilterContainer)
    );

    check(
        "the owner it searches for matches the one persist stored",
        Boolean(listed) &&
            Boolean(persisted) &&
            JSON.stringify(listed.submission.searchFilterContainer).indexOf(
                persisted.submission.data.userId
            ) !== -1,
        "stored=" +
            JSON.stringify(persisted && persisted.submission.data.userId) +
            " queried=" +
            JSON.stringify(listed && listed.submission.searchFilterContainer)
    );

    /* ===================================================== */
    section("The retrieval path carries no sandbox dependency");

    check(
        "Prepare RAG Ingestion does not call require()",
        !/\brequire\s*\(/.test(nodes["Prepare RAG Ingestion"].func),
        (nodes["Prepare RAG Ingestion"].func.match(
            /\brequire\s*\([^)]*\)/g
        ) || []).join(", ")
    );

    console.log("\n" + passed + " passed, " + failed + " failed");

    process.exit(failed === 0 ? 0 : 1);
}

main();
