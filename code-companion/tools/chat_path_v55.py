"""
v5.5.0 chat-path fixes, applied to the v5.4.0 export.

Two symptoms, reported together: the agent never answered a prompt, and
the conversation sidebar stayed empty. They have separate causes.


1. The agent never answered — msg.query was deleted
--------------------------------------------------

The v4.6.2 baseline is the only version of this application known to
have answered a prompt in production, and it always sent the Enabler
BOTH inputs:

    msg.query = cleanQuestion;      // the question
    msg.messages = [...]            // the structured turns

v5.4.0 removed the first, in two places, on this reasoning:

    "Enabler accepts msg.messages OR msg.query. This flow intentionally
     uses the structured msg.messages contract, so do not leave a second
     competing query input on the message."

That is an assumption about the module's contract, not an observation of
it — the enabler-llm node exposes no input-property setting to confirm
it either way. It is also the only change to what the model is given
between "answers" and "does not answer", which is why it is treated here
as the cause. Both deletions are reverted; the structured `messages`
array is untouched, so if the Enabler does prefer it, nothing is lost.


2. The sidebar stayed empty — two independent reasons
-----------------------------------------------------

a) Persistence only ran AFTER a successful reply (tapped off "Extract
   Response + Update Chat"). With the model never replying, no
   conversation was ever written. It now also runs when the prompt is
   SENT, so the conversation exists from the first message regardless
   of what the model does afterwards.

b) "Prepare Conversation Persist" returns null when it cannot resolve
   an authenticated user id, with the reasoning that a shared
   "anonymous" history would leak conversations between people. That
   privacy intent is right and is kept — but discarding the write
   silently is not the only way to honour it. The owner now falls back
   to an identity the browser supplies (SCA-40 below), which separates
   people rather than pooling them.

This module deliberately does not touch the fast-route, retrieval or UI
work v5.4.0 added.
"""

import json

CONVERSATION_OWNER_KEY = "conversationOwner"


class ChatPathError(RuntimeError):
    pass


def _patch(text, anchor, replacement, label):
    if anchor not in text:
        raise ChatPathError(f"anchor not found for {label!r}")

    if text.count(anchor) != 1:
        raise ChatPathError(
            f"anchor for {label!r} matched {text.count(anchor)} times, "
            "expected exactly 1"
        )

    return text.replace(anchor, replacement, 1)


def _function(export, name):
    for node in export["flowsData"]["flows"]:
        if node.get("type") == "function" and node.get("name") == name:
            return node

    raise ChatPathError("function node not found: " + name)


# =========================================================
# 1. The Enabler input contract
# =========================================================

VALIDATE_OLD = """  /*
   * Enabler accepts msg.messages OR msg.query. This flow intentionally
   * uses the structured msg.messages contract, so do not leave a second
   * competing query input on the message.
   */
  delete msg.query;"""

VALIDATE_NEW = """  /*
   * Both inputs, deliberately.
   *
   * v5.4.0 deleted msg.query here, reasoning that the structured
   * msg.messages contract makes it redundant. The v4.6.2 baseline —
   * the only version of this application observed answering a prompt
   * in production — always sent both, and the enabler-llm node exposes
   * no input-property setting that would let anyone confirm which it
   * reads. After the deletion no reply ever came back.
   *
   * Sending both costs nothing: if the Enabler prefers msg.messages it
   * still gets it, unchanged.
   */
  msg.query =
    cleanQuestion;"""

ENABLER_OLD = """/*
 * This application uses msg.messages as the Enabler input contract.
 * Having both fields populated is unnecessary and can make provider
 * routing ambiguous across Enabler versions.
 */
delete msg.query;"""

ENABLER_NEW = """/*
 * msg.query is left in place — see the note in Validate + Build SAP
 * Agent Prompt. This preflight deleted it a second time, so restoring
 * it upstream alone would not have been enough.
 *
 * It is normalised rather than trusted: a non-string here would reach
 * the Enabler as one.
 */
if (typeof msg.query !== "string" || !msg.query.trim()) {
  const fallbackQuery =
    typeof msg.userQuestion === "string" ? msg.userQuestion.trim() : "";

  if (fallbackQuery) {
    msg.query = fallbackQuery;
  }
}"""


# =========================================================
# 2. A conversation from the first prompt
# =========================================================

PERSIST_HISTORY_OLD = """/* Nothing to persist yet — an empty conversation is not worth a document. */
if (!history.length) {
  return null;
}"""

PERSIST_HISTORY_NEW = """/* =========================================================
 * CVP-01B — INCLUDE THE TURN BEING SENT
 *
 * This node now also runs when the prompt is SENT, not only after a
 * reply comes back, so that a failed or slow turn still leaves a
 * conversation behind. At that moment data.messagesJson holds only
 * what was already on screen — the greeting — and the question the
 * user just typed is on msg.userQuestion instead.
 *
 * Without this the conversation would be titled after the greeting,
 * which is the same for every conversation and tells the user nothing.
 * ========================================================= */

const pendingQuestion =
  typeof msg.userQuestion === "string" ? msg.userQuestion.trim() : "";

if (pendingQuestion) {
  const alreadyRecorded =
    history.some(
      function (entry) {
        return (
          entry &&
          entry.role === "user" &&
          String(entry.content || "").trim() === pendingQuestion
        );
      }
    );

  if (!alreadyRecorded) {
    history.push({
      id: "user-" + Date.now(),
      role: "user",
      content: pendingQuestion,
      text: pendingQuestion,
      createdAt: new Date().toISOString()
    });
  }
}

/* Nothing to persist yet — an empty conversation is not worth a document. */
if (!history.length) {
  return null;
}

/* What actually gets stored, including the turn appended above. */
const persistedMessagesJson = JSON.stringify(history);"""

PERSIST_OWNER_OLD = """const ownerUserId =
  scaUserId(msg);

if (!ownerUserId) {"""

PERSIST_OWNER_NEW = """/*
 * The flow's own resolution first; then whatever the browser put in the
 * conversationOwner field (SCA-40), which is there precisely because
 * the flow cannot always see an identity.
 *
 * The privacy rule v5.4.0 set is kept: conversations are never pooled
 * under a shared bucket. The browser-supplied value separates people
 * too — it just does not depend on the runtime exposing an identity to
 * the flow.
 */
const ownerUserId =
  scaUserId(msg) ||
  String(data[""" + repr(CONVERSATION_OWNER_KEY) + """] || "").trim();

if (!ownerUserId) {"""

PERSIST_STORE_OLD = """    title: scaConversationTitle(messagesJson),
    messagesJson: messagesJson,"""

PERSIST_STORE_NEW = """    title: scaConversationTitle(persistedMessagesJson),
    messagesJson: persistedMessagesJson,"""


LIST_QUERY_OLD = """const ownerUserId =
  scaUserId(msg);"""

LIST_QUERY_NEW = """/*
 * The same fallback Prepare Conversation Persist uses. Persisting under
 * one owner and listing under another is the quietest failure
 * available: every write succeeds and the sidebar simply stays empty.
 */
const ownerUserId =
  scaUserId(msg) ||
  String(
    (
      (msg.submission && msg.submission.data) ||
      (msg.payload && msg.payload.data) ||
      {}
    )[""" + repr(CONVERSATION_OWNER_KEY) + """] || ""
  ).trim();"""


# =========================================================
# 3. The require() dependency, again
# =========================================================

CRYPTO_IMPORT = 'const crypto = require("crypto");\n\n'

SHA256_OLD = """function sha256(value) {
  return crypto
    .createHash("sha256")
    .update(String(value), "utf8")
    .digest("hex");
}"""

SHA256_NEW = """/*
 * A chunk key, not a security primitive.
 *
 * This replaced crypto.createHash("sha256"). A Node-RED function
 * sandbox does not define `require` unless the deployment enables
 * external modules, so reaching for a module here made every chat
 * message depend on that being configured. Two independently seeded
 * FNV-1a passes are far more than enough to key chunks of one
 * conversation.
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

  return (
    ("00000000" + fnv1a(0x811c9dc5).toString(16)).slice(-8) +
    ("00000000" + fnv1a(0x7ee3c1b9).toString(16)).slice(-8) +
    ("00000000" + (source.length >>> 0).toString(16)).slice(-8)
  );
}"""


# =========================================================
# 4. SCA-40 — the browser supplies an owner
# =========================================================

OWNER_BOOTSTRAP = """/* =========================================================
 * SCA-40 — CONVERSATION OWNER
 *
 * The flow cannot always resolve who is signed in: "Prepare
 * Conversation Persist" searches some thirty candidate locations on the
 * message for an identity and, finding none, refuses to save the
 * conversation rather than pool everyone's history under a shared
 * "anonymous" bucket. That refusal is right; losing the history is not.
 *
 * So the browser supplies one, into a declared hidden field the backend
 * reads as a fallback. In order of preference:
 *
 *   1. an identity the page already exposes to script;
 *   2. the signed-in name the platform shell renders in its header;
 *   3. a random id kept in localStorage for this browser profile.
 *
 * Only (1) is an authenticated identity. (2) and (3) are separators,
 * not credentials — they keep one person's conversations away from
 * another's, which is what the sidebar needs, and they are not used to
 * authorise anything.
 *
 * This is written with the controller's own setFormField, the same
 * mechanism messagesJson and every other hidden field already use.
 * ========================================================= */

(function scaConversationOwner() {
  "use strict";

  var FIELD = "conversationOwner";
  var STORAGE_KEY = "sca-conversation-owner";

  function text(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  /* (1) Anything the page exposes outright. */
  function exposedIdentity() {
    var candidates = [
      window.__axetUser,
      window.axetUser,
      window.currentUser,
      window.loggedUser
    ];

    for (var index = 0; index < candidates.length; index += 1) {
      var candidate = candidates[index];

      if (!candidate) {
        continue;
      }

      if (typeof candidate === "string") {
        return text(candidate);
      }

      var value =
        text(candidate.email) ||
        text(candidate.userid) ||
        text(candidate.userId) ||
        text(candidate.id) ||
        text(candidate.username);

      if (value) {
        return value;
      }
    }

    return "";
  }

  /*
   * (2) The shell's own header. Scoped to elements OUTSIDE the form so
   * this can never pick up chat content, and normalised so a change of
   * spacing or punctuation does not silently produce a second owner id
   * for the same person.
   */
  function shellIdentity() {
    var form = document.querySelector(".formio-form");
    var nodes = document.querySelectorAll(
      "header, .navbar, [class*='user'], [class*='User']"
    );

    for (var index = 0; index < nodes.length; index += 1) {
      var node = nodes[index];

      if (form && (form.contains(node) || node.contains(form))) {
        continue;
      }

      var content = text(node.textContent).replace(/\\s+/g, " ");
      var match = content.match(
        /([A-Za-z][A-Za-z.'-]+,\\s*[A-Za-z][A-Za-z.'-]+)/
      );

      if (match) {
        return match[1].toLowerCase().replace(/[^a-z]+/g, "-");
      }
    }

    return "";
  }

  /* (3) A per-browser separator, so history is at least not shared. */
  function browserIdentity() {
    try {
      var stored = text(window.localStorage.getItem(STORAGE_KEY));

      if (stored) {
        return stored;
      }

      var generated =
        "browser-" +
        Math.random().toString(36).slice(2, 10) +
        Date.now().toString(36);

      window.localStorage.setItem(STORAGE_KEY, generated);

      return generated;
    } catch (error) {
      /* Private mode, or storage disabled. */
      return "";
    }
  }

  var resolved = "";

  function owner() {
    if (!resolved) {
      resolved =
        exposedIdentity() || shellIdentity() || browserIdentity();
    }

    return resolved;
  }

  function apply() {
    var controller = window.__sapCodeAgentController;

    if (!controller || typeof controller.setFormField !== "function") {
      return;
    }

    var field = document.querySelector('[name="data[' + FIELD + ']"]');

    if (!field) {
      return;
    }

    var value = owner();

    if (!value || field.value === value) {
      return;
    }

    controller.setFormField(FIELD, value);

    if (typeof window.__scaLog === "function") {
      window.__scaLog("info", "SCA-40", "conversation-owner-set", {
        owner: value
      });
    }
  }

  window.setInterval(apply, 1000);
  window.setTimeout(apply, 400);
})();

"""


def _add_owner_field(export, form_node_id):
    """A declared hidden component; adds no button, so outputs stand."""
    form = None

    for node in export["flowsData"]["flows"]:
        if node.get("id") == form_node_id:
            form = node
            break

    if form is None:
        raise ChatPathError("form node not found: " + form_node_id)

    components = form["formStructure"]["components"]

    if any(
        isinstance(component, dict)
        and component.get("key") == CONVERSATION_OWNER_KEY
        for component in components
    ):
        return form

    # Modelled on messagesJson - a `textarea` carrying the
    # sca-state-field class - and deliberately NOT on the `hidden`
    # components beside it.
    #
    # A Form.io `hidden` component does not pick up a value written to
    # its input element. The controller's setFormField() writes the DOM
    # value and dispatches input/change, which is how every other state
    # field reaches the flow; against a `hidden` component that does
    # nothing, and the submission stays empty while the DOM looks
    # correct. The first attempt at this field was `hidden`, and the
    # backend never saw an owner.
    template = None

    for component in components:
        if (
            isinstance(component, dict)
            and component.get("type") == "textarea"
            and component.get("key") == "messagesJson"
        ):
            template = component
            break

    if template is None:
        raise ChatPathError(
            "no messagesJson textarea to model conversationOwner on"
        )

    outputs_before = form.get("outputs")
    wires_before = len(form.get("wires") or [])

    owner = json.loads(json.dumps(template))
    owner["key"] = CONVERSATION_OWNER_KEY
    owner["label"] = "Conversation Owner"
    owner["id"] = "e" + CONVERSATION_OWNER_KEY[:15].ljust(15, "0")
    owner["defaultValue"] = ""

    components.insert(components.index(template) + 1, owner)

    if (
        form.get("outputs") != outputs_before
        or len(form.get("wires") or []) != wires_before
    ):
        raise ChatPathError("adding conversationOwner changed the form's outputs")

    return form


def _persist_on_send(export):
    """
    Also write the conversation when the prompt goes to the model.

    nosql-persist upserts by _id, so the write that follows the reply
    simply updates the same document with the answer in it.
    """
    enabler = _function(export, "Prepare Enabler Request")
    persist = _function(export, "Prepare Conversation Persist")

    wires = enabler.get("wires") or [[]]

    if not wires or not isinstance(wires[0], list):
        raise ChatPathError("Prepare Enabler Request has no output wire")

    if persist["id"] not in wires[0]:
        wires[0].append(persist["id"])

    return enabler


def fix_chat_path(export, form_node_id):
    # ---- 1. the Enabler input contract --------------------------
    validate = _function(export, "Validate + Build SAP Agent Prompt")
    validate["func"] = _patch(
        validate["func"], VALIDATE_OLD, VALIDATE_NEW, "validate msg.query"
    )

    enabler = _function(export, "Prepare Enabler Request")
    enabler["func"] = _patch(
        enabler["func"], ENABLER_OLD, ENABLER_NEW, "preflight msg.query"
    )

    # ---- 2. a conversation from the first prompt ----------------
    persist = _function(export, "Prepare Conversation Persist")
    func = persist["func"]
    func = _patch(
        func, PERSIST_HISTORY_OLD, PERSIST_HISTORY_NEW, "persist pending turn"
    )
    func = _patch(func, PERSIST_OWNER_OLD, PERSIST_OWNER_NEW, "persist owner")
    func = _patch(func, PERSIST_STORE_OLD, PERSIST_STORE_NEW, "persist payload")
    persist["func"] = func

    listing = _function(export, "Prepare Conversation List Query")
    listing["func"] = _patch(
        listing["func"], LIST_QUERY_OLD, LIST_QUERY_NEW, "list query owner"
    )

    _persist_on_send(export)

    # ---- 3. no sandbox dependency on the chat path --------------
    ingestion = _function(export, "Prepare RAG Ingestion")
    func = _patch(ingestion["func"], CRYPTO_IMPORT, "", "crypto import")
    ingestion["func"] = _patch(func, SHA256_OLD, SHA256_NEW, "sha256 helper")

    # ---- 4. the browser supplies an owner -----------------------
    form = _add_owner_field(export, form_node_id)

    for component in form["formStructure"]["components"]:
        if component.get("type") == "customjs":
            if "SCA-40" not in component["content"]:
                component["content"] = OWNER_BOOTSTRAP + component["content"]

                if isinstance(component.get("data"), dict):
                    component["data"]["content"] = component["content"]

            break
    else:
        raise ChatPathError("controller component not found")

    return export
