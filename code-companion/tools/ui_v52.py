"""
v5.2.0 user-interface reshaping.

Everything here follows one rule, learned from three production
failures in a row:

    A declared interactive Form.io component exists for its BEHAVIOUR
    and its VALUE. It is never styled into bespoke chrome, and its
    internals are never decorated at runtime. Anything the developer is
    meant to see is plain HTML inside an `htmlelement` component, which
    is the one thing that has always rendered exactly as authored in
    the real deployment.

What went wrong when that rule was not followed:

  * v4.7.0 built the paperclip and its <input type="file"> in script.
    Nothing rendered in production at all.
  * v5.0.0/v5.1.0 declared a real `file` component and then tried to
    dress it up — hiding Form.io's own file list and relabelling its
    browse link from JavaScript, and listening for a change event on an
    input "inside" it. The input does not exist (File.browseFiles()
    creates a transient one on document.body and removes it again), so
    no file was ever ingested; and the cosmetic decoration is
    version- and timing-dependent, so in the real deployment the
    component's stock chrome showed through: an empty
    "File Name / Size" table and a "Drop files to attach, or browse"
    zone sitting across the message box.
  * The same release let Form.io's datagrid render the conversation
    list. Form.io materialises one blank row for an empty datagrid
    whatever `defaultValue: []` says, so the sidebar showed a phantom
    row of editable text inputs 458px wide inside a 239px column.

So in v5.2.0 the `file` and `datagrid` components are kept, and hidden
by structural CSS keyed on their own stable `formio-component-<key>`
class — never a class added at runtime, which is what made the previous
attempt depend on when the controller happened to run.

This module is idempotent: it reshapes components that the v5.1.0
baseline already contains, so a rebuild over an already-reshaped export
is a no-op rather than a duplication.
"""

from node_builders import htmlelement_component, new_id


# The visible attach control, plus the chip tray it sits beside. Both
# live in one htmlelement so the composer's attachment row is a single
# flex line the stylesheet can lay out, rather than two components whose
# boxes have to be positioned relative to each other.
ATTACHMENT_BAR_HTML = """
<div class="sca-attachment-bar">
  <button id="sca-attach-button" type="button" class="sca-attach-button"
          title="Attach a document (DOCX, PDF, TXT, MD)"
          aria-label="Attach a document">
    <svg class="sca-attach-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.19 9.19a2 2 0 0 1-2.83-2.83l8.49-8.49"/>
    </svg>
    <span class="sca-attach-label">Attach</span>
  </button>

  <div id="sca-attachment-tray" role="list" aria-label="Attached files" hidden></div>
</div>
""".strip()


# The conversation list the developer actually sees. The datagrid still
# holds the data and still owns the per-row buttons that talk to the
# backend; this is only its presentation.
CONVERSATION_LIST_HTML = """
<div id="sca-conversation-list" class="sca-conversation-list" role="list">
  <p class="sca-conversation-empty">No conversations yet.</p>
</div>
""".strip()


class ReshapeError(RuntimeError):
    pass


def _find(components, key):
    for component in components or []:
        if not isinstance(component, dict):
            continue

        if component.get("key") == key:
            return component

        found = _find(component.get("components"), key)

        if found:
            return found

        columns = component.get("columns")

        if isinstance(columns, list):
            for column in columns:
                if not isinstance(column, dict):
                    continue

                nested = column.get("components")

                if isinstance(nested, list):
                    found = _find(nested, key)

                    if found:
                        return found

    return None


def _parent_of(components, key):
    """Returns the list that directly contains `key`."""
    for component in components or []:
        if isinstance(component, dict) and component.get("key") == key:
            return components

    for component in components or []:
        if not isinstance(component, dict):
            continue

        found = _parent_of(component.get("components"), key)

        if found:
            return found

    return None


def reshape_ui(export, form_node_id):
    """
    Applies the v5.2.0 presentation changes to an export that already
    carries the v5.0.0/v5.1.0 component tree.

    No buttons are added or removed, so the form node's `outputs` and
    `wires` are untouched — the whole change is presentational.
    """
    form = None

    for node in export["flowsData"]["flows"]:
        if node.get("id") == form_node_id:
            form = node
            break

    if form is None:
        raise ReshapeError("form node not found: " + form_node_id)

    components = form["formStructure"]["components"]

    outputs_before = form.get("outputs")
    wires_before = len(form.get("wires") or [])

    # ---- 1. the composer's attachment row ---------------------------
    tray_host = _find(components, "attachmentTrayHost")

    if tray_host is None:
        raise ReshapeError("attachmentTrayHost not found — expected v5.1.0 baseline")

    tray_host["content"] = ATTACHMENT_BAR_HTML

    if isinstance(tray_host.get("data"), dict):
        tray_host["data"]["content"] = ATTACHMENT_BAR_HTML

    # ---- 2. the sidebar's conversation list -------------------------
    grid = _find(components, "conversationsGrid")

    if grid is None:
        raise ReshapeError("conversationsGrid not found — expected v5.1.0 baseline")

    siblings = _parent_of(components, "conversationsGrid")

    if siblings is None:
        raise ReshapeError("could not locate the conversationsGrid's parent")

    existing = _find(components, "conversationListHost")

    if existing is None:
        list_host = htmlelement_component(
            "conversationListHost",
            "Conversation List",
            CONVERSATION_LIST_HTML,
            new_id(),
        )

        # Before the datagrid, so the visible list is first in the
        # reading order; the datagrid that follows it is hidden.
        siblings.insert(siblings.index(grid), list_host)
    else:
        existing["content"] = CONVERSATION_LIST_HTML

        if isinstance(existing.get("data"), dict):
            existing["data"]["content"] = CONVERSATION_LIST_HTML

    # ---- 3. nothing may have shifted the button/output mapping ------
    if form.get("outputs") != outputs_before or len(form.get("wires") or []) != wires_before:
        raise ReshapeError(
            "reshape_ui changed the form's output/wire shape "
            f"({outputs_before}/{wires_before} -> "
            f"{form.get('outputs')}/{len(form.get('wires') or [])}); "
            "it must only ever change presentation"
        )

    return form
