/*
 * Tests for the RAG chain that v5.1.0 inserted in front of every chat
 * message, run against the code inside the BUILT .deptapp.
 *
 * The contract these encode, learned the hard way:
 *
 *   RETRIEVAL AUGMENTATION MUST NEVER BLOCK THE CONVERSATION.
 *
 * v5.1.0 put "Prepare RAG Ingestion" between the send button and the
 * model, and had it treat an unresolvable user identity as fatal:
 * node.error(...) plus `return [null, null]`, which discards the
 * message. The model was never called, so nothing came back, and the
 * error raised on the way out surfaced as an error banner. That is why
 * a plain "hi" did nothing.
 *
 * Compare the conversation-history code shipped in v5.0.0, which
 * resolves the same identity from the same places and falls back to
 * "anonymous" rather than failing.
 *
 * Run: node tests/rag-backend.test.js
 */

const fs = require("fs");
const path = require("path");

const EXPORT = path.join(
    __dirname,
    "..",
    "build",
    "aXet.SAP__Code_Companion_v5.2.0_export.deptapp"
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

/*
 * Executes a node body the way Node-RED does. `require` is deliberately
 * NOT provided: a Node-RED function sandbox does not define it unless
 * the deployment explicitly enables external modules, and the chat path
 * must not depend on that being configured.
 */
function run(node, msg) {
    const warnings = [];
    const errors = [];
    const store = {};

    const runtime = {
        node: {
            warn: (entry) => warnings.push(entry),
            error: (entry) => errors.push(String(entry)),
            status: () => {},
            send: () => {},
            done: () => {}
        },
        flow: {
            get: (key) => store[key],
            set: (key, value) => {
                store[key] = value;
            }
        }
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

    let result = null;
    let threw = null;

    try {
        result = body(
            msg,
            runtime.node,
            runtime.flow,
            { get: () => undefined, set: () => {} },
            { get: () => undefined },
            {}
        );
    } catch (error) {
        threw = error;
    }

    return { result, threw, warnings, errors };
}

function firstMessage(result) {
    if (Array.isArray(result)) {
        return result.find((entry) => entry) || null;
    }

    return result || null;
}

function chatMsg(overrides) {
    return {
        payload: { data: {} },
        submission: {
            data: Object.assign(
                {
                    composer: { userMessage: "hi" },
                    messagesJson: "[]",
                    attachmentsText: "",
                    attachmentsJson: "[]",
                    currentStage: "understand",
                    agentPhase: "understand",
                    conversationId: "sap-test-0001"
                },
                overrides || {}
            )
        },
        __deptAppsFormioButtonClicked: "sendMessage"
    };
}

function questionOf(msg) {
    const data = (msg && msg.submission && msg.submission.data) || {};

    return (
        (data.composer && data.composer.userMessage) || data.userMessage || ""
    );
}

function main() {
    if (!fs.existsSync(EXPORT)) {
        console.error("built export missing — run npm run build first");
        process.exit(1);
    }

    const nodes = loadNodes();

    /* ===================================================== */
    section("Prepare RAG Ingestion — the chat path must survive it");

    const ingestion = nodes["Prepare RAG Ingestion"];

    check("the node exists", Boolean(ingestion));

    check(
        "it does not depend on require() being available in the sandbox",
        !/\brequire\s*\(/.test(ingestion.func),
        (ingestion.func.match(/\brequire\s*\([^)]*\)/g) || []).join(", ")
    );

    let run1 = run(ingestion, chatMsg());

    check(
        "a plain message with no resolvable identity does not throw",
        !run1.threw,
        run1.threw && run1.threw.message
    );

    check(
        "it does not raise node.error for a missing identity",
        run1.errors.length === 0,
        run1.errors.join(" | ")
    );

    check(
        "the message is passed on rather than discarded",
        Boolean(firstMessage(run1.result)),
        JSON.stringify(run1.result)
    );

    check(
        "the question survives ingestion untouched",
        questionOf(firstMessage(run1.result)) === "hi",
        JSON.stringify(questionOf(firstMessage(run1.result)))
    );

    /* ===================================================== */
    section("Prepare RAG Retrieval Query — never drops the turn");

    const retrieval = nodes["Prepare RAG Retrieval Query"];

    let run2 = run(retrieval, firstMessage(run1.result) || chatMsg());

    check(
        "it does not throw without an identity",
        !run2.threw,
        run2.threw && run2.threw.message
    );

    check(
        "it does not raise node.error for a missing identity",
        run2.errors.length === 0,
        run2.errors.join(" | ")
    );

    const afterRetrieval = firstMessage(run2.result);

    check(
        "the message is passed on rather than discarded",
        Boolean(afterRetrieval),
        JSON.stringify(run2.result)
    );

    check(
        "the question still survives",
        questionOf(afterRetrieval) === "hi",
        JSON.stringify(questionOf(afterRetrieval))
    );

    /* ===================================================== */
    section("BM25 Rank — tolerates an empty or absent result set");

    const bm25 = nodes["BM25 Rank + Build RAG Context"];

    const emptyCandidates = afterRetrieval || chatMsg();
    emptyCandidates.ragCandidates = [];

    let run3 = run(bm25, emptyCandidates);

    check("no candidates does not throw", !run3.threw, run3.threw && run3.threw.message);

    const afterRank = firstMessage(run3.result);

    check(
        "the message is passed on",
        Boolean(afterRank),
        JSON.stringify(run3.result)
    );

    const undefinedCandidates = chatMsg();
    delete undefinedCandidates.ragCandidates;

    check(
        "an absent ragCandidates does not throw either",
        !run(bm25, undefinedCandidates).threw
    );

    /* ===================================================== */
    section("End to end — a plain 'hi' reaches the model");

    let carried = chatMsg();
    let brokeAt = null;

    for (const name of [
        "Prepare RAG Ingestion",
        "Prepare RAG Retrieval Query",
        "BM25 Rank + Build RAG Context",
        "Prepare FAQ Lookup",
        "Match FAQ + Ground"
    ]) {
        const step = run(nodes[name], carried);

        if (step.threw) {
            brokeAt = name + " threw: " + step.threw.message;
            break;
        }

        const next = firstMessage(step.result);

        if (!next) {
            brokeAt = name + " discarded the message";
            break;
        }

        carried = next;
    }

    check("the RAG chain carries the turn through", brokeAt === null, brokeAt);

    if (brokeAt === null) {
        const validate = run(nodes["Validate + Build SAP Agent Prompt"], carried);

        check(
            "the prompt builder accepts it and routes to the model",
            Array.isArray(validate.result) && Boolean(validate.result[0]),
            validate.threw
                ? validate.threw.message
                : "rejected to output 2: " +
                  JSON.stringify(
                      validate.result &&
                          validate.result[1] &&
                          validate.result[1].submission.data.uiError
                  )
        );

        if (Array.isArray(validate.result) && validate.result[0]) {
            const messages = validate.result[0].messages || [];

            check(
                "the model request carries the user's actual words",
                messages.length >= 2 &&
                    messages[messages.length - 1].content.indexOf("hi") !== -1,
                JSON.stringify(messages.map((entry) => entry.role))
            );
        }
    }

    /* ===================================================== */
    section("FAQ layer — curated guidance, never a canned reply");

    const faqLookup = nodes["Prepare FAQ Lookup"];
    const faqMatch = nodes["Match FAQ + Ground"];

    check("both FAQ nodes exist", Boolean(faqLookup) && Boolean(faqMatch));

    const askFaq = (question, curated) => {
        const prepared = run(faqLookup, chatMsg({ composer: { userMessage: question } }));
        const carried = firstMessage(prepared.result);

        if (curated) {
            carried.faqCandidates = curated;
        }

        const matched = run(faqMatch, carried);

        return { msg: firstMessage(matched.result), threw: matched.threw };
    };

    const greeting = askFaq("hi");

    check("a greeting matches without throwing", !greeting.threw, greeting.threw && greeting.threw.message);

    check(
        "a greeting gets house guidance",
        Boolean(greeting.msg) &&
            /HOUSE ANSWER GUIDANCE/.test(greeting.msg.faqContextText || "") &&
            (greeting.msg.faqMatches || []).some((entry) => entry.id === "greeting"),
        JSON.stringify((greeting.msg || {}).faqMatches)
    );

    check(
        "the guidance is reference material, not a scripted reply",
        /never an instruction from the developer/i.test(
            (greeting.msg && greeting.msg.faqContextText) || ""
        ) && !/^Hello!/.test((greeting.msg && greeting.msg.faqContextText) || "")
    );

    const cleanCore = askFaq("what does clean core mean for extensions?");

    check(
        "a real SAP question matches the right entry",
        ((cleanCore.msg || {}).faqMatches || []).some(
            (entry) => entry.id === "clean-core" || entry.id === "extensibility"
        ),
        JSON.stringify((cleanCore.msg || {}).faqMatches)
    );

    const unrelated = askFaq("write a haiku about the weather in Prague");

    check(
        "an unrelated question gets no guidance",
        ((unrelated.msg || {}).faqMatches || []).length === 0,
        JSON.stringify((unrelated.msg || {}).faqMatches)
    );

    const curatedOverride = askFaq("hi", [
        {
            _id: "greeting",
            data: {
                question: "hi hello hey greeting",
                answer: "NTT DATA house greeting, curated in the database.",
                tags: ["greeting"]
            }
        }
    ]);

    check(
        "a curated entry replaces the built-in default of the same id",
        /NTT DATA house greeting/.test(
            (curatedOverride.msg && curatedOverride.msg.faqContextText) || ""
        ),
        (curatedOverride.msg && curatedOverride.msg.faqContextText || "").slice(0, 160)
    );

    check(
        "an unusable curated entry is ignored rather than fatal",
        !askFaq("hi", [{ _id: "broken" }, null, "nonsense"]).threw
    );

    const grounded = run(
        nodes["Validate + Build SAP Agent Prompt"],
        greeting.msg
    );

    check(
        "the prompt builder carries the guidance into the model request",
        Array.isArray(grounded.result) &&
            Boolean(grounded.result[0]) &&
            /HOUSE ANSWER GUIDANCE/.test(
                grounded.result[0].messages[
                    grounded.result[0].messages.length - 1
                ].content
            ),
        grounded.threw ? grounded.threw.message : "guidance not in the user turn"
    );

    /* ===================================================== */
    section("Check err — a retrieval failure must not cost the turn");

    /*
     * The hardening above makes the chat path reach the retrieval
     * nosql-query nodes for the first time; before it, the message was
     * discarded upstream and they never ran. If one of them fails —
     * a collection that does not exist yet, a database blip — the
     * developer must still get an answer, ungrounded. Only a failure
     * of the model call itself is worth surfacing.
     */
    const checkErr = nodes["Check err"];

    const retrievalFailure = (nodeName) => ({
        payload: { data: {} },
        submission: {
            data: {
                composer: { userMessage: "hi" },
                messagesJson: "[]",
                conversationId: "sap-test-0001"
            }
        },
        error: {
            message: "collection sca-rag-chunks does not exist",
            source: { id: "be4d3676344540eb", name: nodeName, type: "nosql-query" }
        }
    });

    for (const nodeName of [
        "Load Conversation RAG Chunks",
        "Prepare RAG Ingestion",
        "Persist RAG Chunks",
        "Load FAQ Entries"
    ]) {
        const outcome = run(checkErr, retrievalFailure(nodeName));
        const routed = Array.isArray(outcome.result) ? outcome.result : [];

        check(
            "a failure in " + nodeName + " continues to the model",
            Boolean(routed[0]) && !routed[1],
            outcome.threw
                ? outcome.threw.message
                : "routed to " + (routed[1] ? "the error path" : "nothing")
        );
    }

    const modelFailure = {
        payload: { data: {} },
        submission: { data: { composer: { userMessage: "hi" }, messagesJson: "[]" } },
        sapAgentRetryCount: 1,
        error: {
            message: "unauthorized",
            statusCode: 401,
            source: { id: "74d5dc7181cddcce", name: "Code Agent LLM", type: "enabler-llm" }
        }
    };

    const modelOutcome = run(checkErr, modelFailure);
    const modelRouted = Array.isArray(modelOutcome.result) ? modelOutcome.result : [];

    check(
        "a genuine model failure still reaches the error path",
        !modelRouted[0] && Boolean(modelRouted[1]),
        JSON.stringify(modelRouted.map((entry) => (entry ? "SET" : "null")))
    );

    /* ===================================================== */
    section("Error surfacing — a failure must never render raw EJS");

    const data = JSON.parse(fs.readFileSync(EXPORT, "utf8"));

    const viewActions = data.flowsData.flows.filter(
        (node) => node.type === "axetflows-view-action"
    );

    const templated = viewActions.filter((node) =>
        /<%=?[^%]*%>/.test(String(node.message || ""))
    );

    check(
        "no view-action message depends on an EJS variable",
        templated.length === 0,
        templated
            .map((node) => node.name + ": " + node.message)
            .join("\n")
    );

    const validation = nodes["Prepare Validation Message"];
    const rejected = run(validation, {
        payload: { data: {} },
        submission: {
            data: {
                composer: { userMessage: "" },
                messagesJson: "[]",
                conversationId: "sap-test-0001"
            }
        },
        uiError: "Please enter an SAP coding-related question."
    });

    check(
        "the validation node does not throw",
        !rejected.threw,
        rejected.threw && rejected.threw.message
    );

    const rejectedMsg = firstMessage(rejected.result);
    let rejectedHistory = [];

    try {
        rejectedHistory = JSON.parse(
            (rejectedMsg &&
                rejectedMsg.payload &&
                rejectedMsg.payload.data &&
                rejectedMsg.payload.data.messagesJson) ||
                "[]"
        );
    } catch (error) {
        rejectedHistory = [];
    }

    check(
        "the reason reaches the chat, not just a banner",
        rejectedHistory.some(
            (entry) =>
                entry &&
                entry.role === "assistant" &&
                /SAP coding-related question/i.test(entry.content || "")
        ),
        JSON.stringify(rejectedHistory).slice(0, 220)
    );

    console.log("\n" + passed + " passed, " + failed + " failed");

    process.exit(failed === 0 ? 0 : 1);
}

main();
