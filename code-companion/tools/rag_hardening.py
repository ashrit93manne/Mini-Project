"""
v5.2.0 hardening of the RAG chain v5.1.0 put in front of every chat turn.

The principle, and the reason this module exists:

    RETRIEVAL AUGMENTATION MUST NEVER BLOCK THE CONVERSATION.

v5.1.0 rewired the chat path from

    SAP Chat Request -> Validate + Build SAP Agent Prompt -> LLM

to

    SAP Chat Request -> Prepare RAG Ingestion -> [nosql-persist]
                     -> Prepare RAG Retrieval Query -> [nosql-query]
                     -> BM25 Rank -> Validate + Build SAP Agent Prompt -> LLM

so every message — including a plain "hi" with no attachment — now
depends on resolving a user identity and on two NoSQL round-trips. Two
places treated a miss as fatal:

  * Prepare RAG Ingestion: `node.error(...)` plus `return [null, null]`
    when no user identity resolved. That DISCARDS the message. The model
    is never called, so nothing comes back, and the raised error travels
    to the catch node and surfaces as an error banner. Both symptoms of
    "the agent is not working" come from this one branch.
  * Prepare RAG Retrieval Query: `node.error(...)` plus `return null`
    for the same reason.

The conversation-history code shipped in v5.0.0 resolves the same
identity from the same places and falls back to "anonymous". That is the
behaviour the chat path needs.

The third fix removes `require("crypto")`. A Node-RED function sandbox
does not define `require` unless the deployment enables external
modules, and nothing as central as the chat path should depend on that
being configured. It was used for one hash, which is inlined instead.
"""


class RagPatchError(RuntimeError):
    pass


def _patch(text, anchor, replacement, label):
    if anchor not in text:
        raise RagPatchError(
            f"rag hardening: anchor not found for {label!r}"
        )

    if text.count(anchor) != 1:
        raise RagPatchError(
            f"rag hardening: anchor for {label!r} matched "
            f"{text.count(anchor)} times, expected 1"
        )

    return text.replace(anchor, replacement, 1)


# ---------------------------------------------------------------
# 1. Drop the require() dependency
# ---------------------------------------------------------------

CRYPTO_IMPORT = 'const crypto = require("crypto");\n\n'

SHA256_OLD = '''function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex");
}'''

SHA256_NEW = '''/*
 * A chunk key, not a security primitive: it only has to distinguish one
 * chunk of text from another within a conversation.
 *
 * This replaced crypto.createHash("sha256"). A Node-RED function
 * sandbox does not define `require` unless the deployment enables
 * external modules, so reaching for a module here made every chat
 * message — attachment or not — depend on that being configured. Two
 * independently seeded FNV-1a passes give 64 bits, which is far more
 * than enough to key chunks of a single conversation.
 */
function sha256(value) {
  const source = String(value);

  function fnv1a(seed) {
    let hash = seed;

    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }

    return hash >>> 0;
  }

  const high = fnv1a(0x811c9dc5);
  const low = fnv1a(0x7ee3c1b9);

  return (
    ("00000000" + high.toString(16)).slice(-8) +
    ("00000000" + low.toString(16)).slice(-8) +
    ("00000000" + (source.length >>> 0).toString(16)).slice(-8)
  );
}'''


# ---------------------------------------------------------------
# 2. Ingestion: never discard the turn
# ---------------------------------------------------------------

INGEST_FATAL_OLD = '''const userId =
  resolveUserId(msg);

if (!userId) {
  node.error(
    "RAG ingestion requires an authenticated aXet user identity.",
    msg
  );
  return [null, null];
}'''

INGEST_FATAL_NEW = '''/*
 * An unresolved identity is not a reason to refuse to talk.
 *
 * This branch used to call node.error(..., msg) and `return [null,
 * null]`, which discarded the message: the model was never called, so
 * the user got no answer, and the raised error surfaced as an error
 * banner. Every message went that way, including ones with nothing to
 * ingest at all.
 *
 * "anonymous" is the same fallback the v5.0.0 conversation-history code
 * uses for the same identity, resolved from the same places. Chunks
 * stored under it are still conversation-scoped, so nothing leaks
 * between conversations; the only cost is that they are not scoped per
 * user, which is strictly better than the application not answering.
 */
const userId =
  resolveUserId(msg) ||
  "anonymous";

if (userId === "anonymous") {
  node.warn({
    component: "Prepare RAG Ingestion",
    event: "identity-unresolved",
    detail:
      "No aXet user identity on the message; continuing with " +
      "conversation-scoped chunks under 'anonymous'."
  });
}'''


# ---------------------------------------------------------------
# 3. Retrieval: never discard the turn
# ---------------------------------------------------------------

RETRIEVE_FATAL_OLD = '''if (
  !userId ||
  !conversationId
) {
  node.error(
    "RAG retrieval could not resolve userId/conversationId.",
    msg
  );
  return null;
}'''

RETRIEVE_FATAL_NEW = '''/*
 * Same correction as in Prepare RAG Ingestion: `return null` here
 * dropped the turn on the floor, so the model was never reached.
 *
 * With no identity there is nothing to retrieve, so the message
 * continues with an empty candidate set and the conversation proceeds
 * ungrounded — which is exactly what a chat with no attachments needs
 * anyway.
 */
if (
  !userId ||
  !conversationId
) {
  node.warn({
    component: "Prepare RAG Retrieval Query",
    event: "retrieval-skipped",
    reason: "no userId/conversationId",
    detail: "Continuing without retrieved context."
  });

  msg.ragCandidates = [];
  msg.ragSkipped = true;

  return msg;
}'''


# ---------------------------------------------------------------
# 4. Fail-open wrappers
# ---------------------------------------------------------------

def _wrap_fail_open(body, component, on_failure):
    """
    Wraps a node body so that ANY unexpected throw still forwards the
    message down the chat path instead of reaching the catch node.

    Retrieval is an enhancement. If it breaks, the conversation must
    carry on without it.
    """
    return (
        "/*\n"
        " * Fail-open wrapper (v5.2.0).\n"
        " *\n"
        " * Everything below is an enhancement to the answer, never a\n"
        " * precondition for producing one. Any unexpected failure here\n"
        " * forwards the message on unchanged rather than letting it\n"
        " * reach the catch node, where it would be turned into an error\n"
        " * banner and the user's turn would be lost.\n"
        " */\n"
        "try {\n"
        f"{body}\n"
        "} catch (ragFailure) {\n"
        "  node.warn({\n"
        f'    component: "{component}",\n'
        '    event: "rag-failed-open",\n'
        "    message:\n"
        "      ragFailure && ragFailure.message\n"
        "        ? String(ragFailure.message)\n"
        "        : String(ragFailure)\n"
        "  });\n"
        "\n"
        "  msg.ragCandidates =\n"
        "    Array.isArray(msg.ragCandidates)\n"
        "      ? msg.ragCandidates\n"
        "      : [];\n"
        "\n"
        "  msg.ragSkipped = true;\n"
        "\n"
        f"  return {on_failure};\n"
        "}\n"
    )


def harden_rag(export):
    """Applies every fix above to the built export, in place."""
    by_name = {}

    for node in export["flowsData"]["flows"]:
        if node.get("type") == "function":
            by_name.setdefault(node.get("name"), node)

    # ---- Prepare RAG Ingestion ----------------------------------
    ingestion = by_name.get("Prepare RAG Ingestion")

    if ingestion is None:
        raise RagPatchError("Prepare RAG Ingestion not found")

    func = ingestion["func"]
    func = _patch(func, CRYPTO_IMPORT, "", "crypto import")
    func = _patch(func, SHA256_OLD, SHA256_NEW, "sha256 helper")
    func = _patch(
        func, INGEST_FATAL_OLD, INGEST_FATAL_NEW, "ingestion identity guard"
    )

    # The ingestion node has two outputs: [persist, straight-to-retrieval].
    ingestion["func"] = _wrap_fail_open(
        func, "Prepare RAG Ingestion", "[null, msg]"
    )

    # ---- Prepare RAG Retrieval Query -----------------------------
    retrieval = by_name.get("Prepare RAG Retrieval Query")

    if retrieval is None:
        raise RagPatchError("Prepare RAG Retrieval Query not found")

    func = _patch(
        retrieval["func"],
        RETRIEVE_FATAL_OLD,
        RETRIEVE_FATAL_NEW,
        "retrieval identity guard",
    )

    retrieval["func"] = _wrap_fail_open(
        func, "Prepare RAG Retrieval Query", "msg"
    )

    # ---- BM25 Rank ------------------------------------------------
    rank = by_name.get("BM25 Rank + Build RAG Context")

    if rank is None:
        raise RagPatchError("BM25 Rank + Build RAG Context not found")

    rank["func"] = _wrap_fail_open(
        rank["func"], "BM25 Rank + Build RAG Context", "msg"
    )

    # ---- the FAQ nodes, on the same terms -------------------------
    for name, on_failure in (
        ("Prepare FAQ Lookup", "msg"),
        ("Match FAQ + Ground", "msg"),
    ):
        faq_node = by_name.get(name)

        if faq_node is None:
            raise RagPatchError(name + " not found")

        faq_node["func"] = _wrap_fail_open(faq_node["func"], name, on_failure)

    _harden_check_err(export)

    return export

# ---------------------------------------------------------------
# 5. Check err: a retrieval failure must not cost the developer the turn
# ---------------------------------------------------------------

CHECK_ERR_ANCHOR = """/* =========================================================

 * CER-02 — CLASSIFY TRANSIENT AND PERMANENT FAILURES

 * ========================================================= */"""

CHECK_ERR_BYPASS = """/* =========================================================

 * CER-01B — RETRIEVAL FAILURES ARE NOT THE USER'S PROBLEM

 *

 * Hardening the RAG nodes made the chat path reach the retrieval

 * nosql-query nodes for the first time; before it, the message was

 * discarded upstream and they never ran. A collection that does not

 * exist yet, or a database blip, would otherwise land here and be

 * turned into a user-facing error — losing a turn over a missing

 * enhancement.

 *

 * Output 1 already leads back to Validate + Build SAP Agent Prompt (it

 * is the retry path), so continuing the turn ungrounded needs no new

 * wiring: strip the error, drop whatever retrieval state exists, and

 * send it on. Only failures of the model call itself, or of prompt

 * building, are worth showing anybody.

 * ========================================================= */

const RETRIEVAL_NODE_NAMES = {

  "Prepare RAG Ingestion": 1,

  "Persist RAG Chunks": 1,

  "Prepare RAG Retrieval Query": 1,

  "Load Conversation RAG Chunks": 1,

  "BM25 Rank + Build RAG Context": 1,

  "Prepare FAQ Lookup": 1,

  "Load FAQ Entries": 1,

  "Match FAQ + Ground": 1

};

const failingNodeName =

  msg.error &&

  msg.error.source &&

  msg.error.source.name

    ? String(msg.error.source.name)

    : "";

if (RETRIEVAL_NODE_NAMES[failingNodeName]) {

  node.warn({

    component: "Check err",

    section: "CER-01B",

    event: "retrieval-failure-bypassed",

    failingNode: failingNodeName,

    detail: "Continuing the turn without retrieved context."

  });

  delete msg.error;

  delete msg.safeError;

  msg.ragCandidates = [];

  msg.ragContextText = "";

  msg.faqContextText = "";

  msg.ragSkipped = true;

  node.status({

    fill: "yellow",

    shape: "dot",

    text: "Retrieval skipped"

  });

  return [msg, null];

}



/* =========================================================

 * CER-02 — CLASSIFY TRANSIENT AND PERMANENT FAILURES

 * ========================================================= */"""


def _harden_check_err(export):
    for node in export["flowsData"]["flows"]:
        if node.get("type") == "function" and node.get("name") == "Check err":
            node["func"] = _patch(
                node["func"],
                CHECK_ERR_ANCHOR,
                CHECK_ERR_BYPASS,
                "Check err retrieval bypass",
            )
            return

    raise RagPatchError("Check err node not found")


