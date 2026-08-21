"""
Makes a failed turn readable to the developer.

Two view-action nodes shipped a message template of

    <strong><%= messages.errorTitle %></strong><br>
    <%= messages.error %>

and the deployed application rendered those placeholders literally, as
text, in a red banner across the top of the screen. So whatever the
`messages` object is in scope for on this platform, it is not the
context these templates are evaluated against — and the developer was
shown EJS source instead of a reason.

Rather than guess at the right variable name, the reason is put where
the rest of the conversation already lives: the chat transcript.
`Prepare Safe Error` already does this (its PSE-04 section appends a
safe assistant message and routes to Prepare Chat View Update), and
this makes `Prepare Validation Message` behave the same way.

The banner templates then become plain static text, which cannot render
as source whatever the platform substitutes into.
"""


class ErrorSurfaceError(RuntimeError):
    pass


VALIDATION_BANNER = (
    "Your request was not sent. The reason is shown in the conversation."
)

SAFE_BANNER = (
    "The request could not be completed. The details are shown in the "
    "conversation."
)


HISTORY_APPEND_ANCHOR = """/*
 * Preserve the standard Form payload shape.
 */

msg.payload = {
  data:
    data
};"""

HISTORY_APPEND_NEW = """/* =========================================================
 * PVM-04A — SHOW THE REASON IN THE CONVERSATION
 *
 * The view-action banner is static text (it used to be an EJS
 * template whose variables did not resolve, so the developer was
 * shown "<%= messages.error %>" verbatim). The actual reason belongs
 * in the transcript, the same way Prepare Safe Error's PSE-04 puts
 * backend failures there.
 * ========================================================= */

let validationHistory = [];

try {
  const parsedValidationHistory =
    typeof data.messagesJson === "string"
      ? JSON.parse(data.messagesJson || "[]")
      : data.messagesJson;

  validationHistory =
    Array.isArray(parsedValidationHistory)
      ? parsedValidationHistory
      : [];
} catch (historyError) {
  validationHistory = [];
}

validationHistory =
  validationHistory.filter(
    function (item) {
      return (
        item &&
        (item.role === "user" || item.role === "assistant") &&
        typeof item.content === "string" &&
        item.content.trim() !== ""
      );
    }
  );

const lastValidationEntry =
  validationHistory[validationHistory.length - 1];

const alreadyReported =
  lastValidationEntry &&
  lastValidationEntry.role === "assistant" &&
  lastValidationEntry.content === validationMessage;

if (!alreadyReported) {
  validationHistory.push({
    id: "assistant-validation-" + Date.now(),
    role: "assistant",
    content: validationMessage,
    text: validationMessage,
    isError: true,
    createdAt: new Date().toISOString()
  });
}

validationHistory = validationHistory.slice(-20);

data.messagesJson =
  JSON.stringify(validationHistory);

data.transcript =
  validationHistory
    .map(
      function (item) {
        return (
          (item.role === "user" ? "You" : "SAP Code Agent") +
          ":\\n" +
          item.content
        );
      }
    )
    .join("\\n\\n");

/*
 * Preserve the standard Form payload shape.
 */

msg.payload = {
  data:
    data
};"""


def fix_error_surface(export):
    """Applies both corrections to the built export, in place."""
    flows = export["flowsData"]["flows"]

    # ---- 1. static banner text ----------------------------------
    banners = {
        "Show Validation Error": VALIDATION_BANNER,
        "Show Safe Error": SAFE_BANNER,
    }

    seen = set()

    for node in flows:
        if node.get("type") != "axetflows-view-action":
            continue

        name = node.get("name")

        if name in banners:
            node["message"] = banners[name]
            seen.add(name)

    missing = set(banners) - seen

    if missing:
        raise ErrorSurfaceError(
            "view-action(s) not found: " + ", ".join(sorted(missing))
        )

    # Nothing anywhere may still carry an unresolved template.
    for node in flows:
        if node.get("type") != "axetflows-view-action":
            continue

        message = str(node.get("message") or "")

        if "<%" in message:
            raise ErrorSurfaceError(
                f"view-action {node.get('name')!r} still carries an EJS "
                f"template: {message!r}"
            )

    # ---- 2. put the reason in the transcript --------------------
    validation = None

    for node in flows:
        if (
            node.get("type") == "function"
            and node.get("name") == "Prepare Validation Message"
        ):
            validation = node
            break

    if validation is None:
        raise ErrorSurfaceError("Prepare Validation Message not found")

    func = validation["func"]

    if HISTORY_APPEND_ANCHOR not in func:
        raise ErrorSurfaceError(
            "Prepare Validation Message: payload anchor not found"
        )

    if func.count(HISTORY_APPEND_ANCHOR) != 1:
        raise ErrorSurfaceError(
            "Prepare Validation Message: payload anchor is not unique"
        )

    validation["func"] = func.replace(
        HISTORY_APPEND_ANCHOR, HISTORY_APPEND_NEW, 1
    )

    return export
