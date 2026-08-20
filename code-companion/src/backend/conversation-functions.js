/*
 * Conversation-history backend functions.
 *
 * Not wired into the export directly — build_deptapp.py reads each
 * export below and embeds it as a Node-RED `function` node's `func`.
 * Kept here (rather than as Python string literals) so the JS can be
 * lint/read/diffed normally and unit-tested the same way the other
 * backend functions are, in tests/history-backend.test.js.
 */

/* =========================================================
 * Shared helpers, inlined into every function body that needs them
 * (Node-RED function nodes don't share scope with each other).
 * ========================================================= */

const SHARED_HELPERS = `
function scaUserId(msg) {
  const ctx =
    msg.__axetFlowsSecurityContext ||
    msg.__deptAppsSecurityContext ||
    {};

  return String(
    msg.userid ||
    ctx.userid ||
    ctx.userId ||
    ctx.sub ||
    (ctx.user && ctx.user.id) ||
    (ctx.user && ctx.user.email) ||
    "anonymous"
  ).trim();
}

function scaConversationTitle(messagesJson) {
  try {
    const history = JSON.parse(messagesJson || "[]");
    const firstUserMessage = Array.isArray(history)
      ? history.find(function (entry) {
          return entry && entry.role === "user" && entry.content;
        })
      : null;

    const text = firstUserMessage
      ? String(firstUserMessage.content).trim().replace(/\\s+/g, " ")
      : "";

    if (!text) {
      return "New conversation";
    }

    return text.length > 60 ? text.slice(0, 57) + "..." : text;
  } catch (error) {
    return "New conversation";
  }
}

function scaRelativeTime(isoString) {
  const then = new Date(isoString).getTime();

  if (!isFinite(then)) {
    return "";
  }

  const seconds = Math.round((Date.now() - then) / 1000);

  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return minutes + (minutes === 1 ? " min ago" : " mins ago");
  }

  const hours = Math.round(minutes / 60);

  if (hours < 24) {
    return hours + (hours === 1 ? " hour ago" : " hours ago");
  }

  const days = Math.round(hours / 24);

  if (days < 7) {
    return days + (days === 1 ? " day ago" : " days ago");
  }

  try {
    return new Date(isoString).toLocaleDateString();
  } catch (error) {
    return "";
  }
}
`.trim();

/* =========================================================
 * CVP — Prepare Conversation Persist
 *
 * Tapped off the SAME output as the existing chat-reply path, right
 * after "Extract Response + Update Chat" has finalised data.messagesJson
 * for this turn. Runs in parallel with the reply reaching the browser —
 * it does not gate or delay that path, and a failure here must never
 * break the chat reply itself, hence the broad try/catch with a warn
 * instead of a throw.
 *
 * CVP-01  Read the turn's current state
 * CVP-02  Ensure a conversation id exists
 * CVP-03  Build the document and persist it
 * ========================================================= */

const PREPARE_CONVERSATION_PERSIST = `
${SHARED_HELPERS}

/* =========================================================
 * CVP-01 — READ THE TURN'S CURRENT STATE
 * ========================================================= */

const data =
  (msg.payload && msg.payload.data) ||
  (msg.submission && msg.submission.data) ||
  {};

const messagesJson =
  typeof data.messagesJson === "string" ? data.messagesJson : "[]";

let history = [];

try {
  const parsed = JSON.parse(messagesJson);
  history = Array.isArray(parsed) ? parsed : [];
} catch (error) {
  history = [];
}

/* Nothing to persist yet — an empty conversation is not worth a document. */
if (!history.length) {
  return null;
}

/* =========================================================
 * CVP-02 — ENSURE A CONVERSATION ID EXISTS
 *
 * New Chat already generates one (see "Clear Conversation"); a
 * brand-new browser session that has never clicked New Chat has not,
 * so one is created here on first use and written back into
 * msg.payload.data so the SAME id is reused on every later turn of
 * this conversation instead of a fresh document per message.
 * ========================================================= */

let conversationId = String(data.conversationId || "").trim();

if (!conversationId) {
  conversationId =
    "sap-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10);

  msg.payload = msg.payload || {};
  msg.payload.data = msg.payload.data || {};
  msg.payload.data.conversationId = conversationId;
}

/* =========================================================
 * CVP-03 — BUILD THE DOCUMENT AND PERSIST
 *
 * _id is always the conversation id: every persist call is therefore
 * an unambiguous upsert against a known key, regardless of whether the
 * underlying nosql-persist node auto-generates an id when one is
 * omitted. See docs/CHAT-HISTORY.md for why this sidesteps that
 * otherwise-unverifiable question entirely.
 * ========================================================= */

const now = new Date().toISOString();

msg.submission = {
  _id: conversationId,
  data: {
    userId: scaUserId(msg),
    title: scaConversationTitle(messagesJson),
    messagesJson: messagesJson,
    currentStage: data.currentStage || "understand",
    updatedAt: now
  }
};

node.warn({
  component: "Prepare Conversation Persist",
  section: "CVP-03",
  event: "conversation-persist-prepared",
  conversationId: conversationId,
  historyMessages: history.length
});

return msg;
`.trim();

/* =========================================================
 * CVL — Prepare Conversation List Query
 *
 * Shared by both the explicit "list" entry point and the tail of the
 * delete flow (a deletion should be followed by a fresh list, not a
 * second copy of this same filter-building logic).
 * ========================================================= */

const PREPARE_CONVERSATION_LIST_QUERY = `
${SHARED_HELPERS}

msg.submission = {
  searchFilterContainer: {
    userId: scaUserId(msg)
  },
  paginator: {
    pageNumber: 1,
    itemsPerPage: 50
  }
};

node.warn({
  component: "Prepare Conversation List Query",
  section: "CVL-01",
  event: "conversation-list-query-prepared",
  userId: msg.submission.searchFilterContainer.userId
});

return msg;
`.trim();

/* =========================================================
 * CVA — Apply Conversation List
 *
 * Reshapes whatever nosql-query bound onto msg.submission.conversationsRaw
 * into the flat row shape the conversationsGrid datagrid's own columns
 * expect (title, updatedAtLabel, and the two per-row action flags the
 * datagrid always carries whether or not a row button was clicked).
 *
 * The exact shape nosql-query binds — a flat array of documents, or an
 * array of {_id, data:{...}} envelopes matching the persist shape above
 * — is the one piece of this pipeline this project could not verify
 * against a real database (see docs/CHAT-HISTORY.md). Both shapes are
 * therefore handled defensively rather than assumed.
 * ========================================================= */

const APPLY_CONVERSATION_LIST = `
${SHARED_HELPERS}

function scaConversationFields(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const body =
    entry.data && typeof entry.data === "object" ? entry.data : entry;

  const id = entry._id || entry.id || body._id || body.id;

  if (!id) {
    return null;
  }

  return {
    _id: String(id),
    title: String(body.title || "Untitled conversation"),
    updatedAt: body.updatedAt || body.createdAt || null
  };
}

const rawList =
  (msg.submission && msg.submission.conversationsRaw) || [];

const rows = (Array.isArray(rawList) ? rawList : [])
  .map(scaConversationFields)
  .filter(Boolean)
  .sort(function (a, b) {
    return (
      new Date(b.updatedAt || 0).getTime() -
      new Date(a.updatedAt || 0).getTime()
    );
  })
  .map(function (conversation) {
    return {
      _id: conversation._id,
      title: conversation.title,
      updatedAtLabel: scaRelativeTime(conversation.updatedAt),
      open: false,
      "delete": false
    };
  });

msg.payload = {
  data: {
    conversationsGrid: rows
  }
};

node.warn({
  component: "Apply Conversation List",
  section: "CVA-01",
  event: "conversation-list-applied",
  conversations: rows.length
});

return msg;
`.trim();

/* =========================================================
 * CVS — Get Selected Conversation Id (open row)
 * ========================================================= */

const GET_SELECTED_CONVERSATION_ID = `
const rows =
  (msg.submission && msg.submission.conversationsGrid) || [];

const selected = (Array.isArray(rows) ? rows : []).find(function (row) {
  return row && row.open === true;
});

msg._id = selected ? selected._id : null;

if (!msg._id) {
  node.warn({
    component: "Get Selected Conversation Id",
    section: "CVS-01",
    event: "no-row-selected"
  });
}

return msg._id ? msg : null;
`.trim();

/* =========================================================
 * CVO — Apply Loaded Conversation
 *
 * Reshapes nosql-find-one's result (bound onto msg.payload.data by the
 * node's own bindingProperty) into the flat chat-state shape the
 * EXISTING controller already knows how to render — the same
 * msg.payload.data channel "Extract Response + Update Chat" uses for
 * every normal reply, so no new client-side rendering path is needed.
 * ========================================================= */

const APPLY_LOADED_CONVERSATION = `
const found = (msg.payload && msg.payload.data) || {};

const body =
  found.data && typeof found.data === "object" ? found.data : found;

if (!body || !body.messagesJson) {
  msg.payload = {
    data: {
      uiError: "That conversation could not be found. It may have been deleted."
    }
  };

  node.warn({
    component: "Apply Loaded Conversation",
    section: "CVO-01",
    event: "conversation-not-found",
    requestedId: msg._id
  });

  return msg;
}

msg.payload = {
  data: {
    conversationId: msg._id,
    messagesJson: body.messagesJson,
    currentStage: body.currentStage || "understand",
    agentPhase: body.currentStage || "understand",
    processing: false,
    processingMessage: "",
    uiError: "",
    /* A loaded conversation carries no in-flight attachment. */
    attachmentsText: "",
    attachmentsJson: "[]"
  }
};

node.warn({
  component: "Apply Loaded Conversation",
  section: "CVO-02",
  event: "conversation-loaded",
  conversationId: msg._id
});

return msg;
`.trim();

/* =========================================================
 * CVD — Get Delete Conversation Id (delete row)
 * ========================================================= */

const GET_DELETE_CONVERSATION_ID = `
const rows =
  (msg.submission && msg.submission.conversationsGrid) || [];

const selected = (Array.isArray(rows) ? rows : []).find(function (row) {
  return row && row["delete"] === true;
});

msg._id = selected ? selected._id : null;

if (!msg._id) {
  node.warn({
    component: "Get Delete Conversation Id",
    section: "CVD-01",
    event: "no-row-selected"
  });
}

return msg._id ? msg : null;
`.trim();

module.exports = {
  SHARED_HELPERS,
  PREPARE_CONVERSATION_PERSIST,
  PREPARE_CONVERSATION_LIST_QUERY,
  APPLY_CONVERSATION_LIST,
  GET_SELECTED_CONVERSATION_ID,
  APPLY_LOADED_CONVERSATION,
  GET_DELETE_CONVERSATION_ID
};
