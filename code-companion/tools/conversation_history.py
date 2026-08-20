"""
Adds the conversation-history feature to the export: persistence via
the platform's NoSQL nodes, a datagrid-backed sidebar, and the backend
wiring connecting them.

See docs/CHAT-HISTORY.md for the design rationale and the one piece of
this that could not be verified against a real database (the exact
document shape nosql-query binds back).
"""
import os

from node_builders import (
    button_component,
    columns_component,
    container_component,
    datagrid_component,
    file_component,
    function_node,
    htmlelement_component,
    link_in_node,
    link_out_node,
    new_id,
    nosql_find_one_node,
    nosql_persist_node,
    nosql_query_node,
    nosql_remove_node,
    readonly_textfield_component,
    unique_id,
    view_action_update_node,
)

COLLECTION = "sca-conversations"

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def _read_backend_function(export_name):
    """
    Pulls one export (e.g. PREPARE_CONVERSATION_PERSIST) out of
    src/backend/conversation-functions.js by evaluating it under Node,
    so the JS lives in one reviewable/testable file rather than as
    Python string literals.
    """
    import json
    import subprocess

    script = (
        "const fns = require(%r);"
        "process.stdout.write(JSON.stringify(fns[%r]));"
    ) % (
        os.path.join(ROOT, "src", "backend", "conversation-functions.js"),
        export_name,
    )

    result = subprocess.run(
        ["node", "-e", script], capture_output=True, text=True, check=True
    )

    return json.loads(result.stdout)


SUPPORTED_EXTENSIONS = [".docx", ".pdf", ".txt", ".md", ".markdown"]

SIDEBAR_HEADER_HTML = """
<div class="sca-sidebar-title-row">
  <span class="sca-sidebar-title">Conversations</span>
  <button id="sca-history-refresh" type="button" title="Refresh conversation list" aria-label="Refresh conversation list">&#8635;</button>
</div>
<button id="sca-new-conversation" type="button">New Conversation</button>
""".strip()

ATTACHMENT_TRAY_HTML = (
    '<div id="sca-attachment-tray" role="list" aria-label="Attached files" hidden></div>'
)

SIDEBAR_TOGGLE_HTML = (
    '<button id="sca-sidebar-toggle" type="button" '
    'aria-label="Show conversation history" title="Conversation history">&#9776;</button>'
)


def find_node_by_id(flows, node_id):
    for node in flows:
        if node["id"] == node_id:
            return node

    raise KeyError("node id not found: " + node_id)


def find_node_by_name(flows, name):
    for node in flows:
        if node.get("name") == name:
            return node

    raise KeyError("node name not found: " + name)


def find_component(components, key):
    for component in components:
        if not isinstance(component, dict):
            continue

        if component.get("key") == key:
            return component

        if isinstance(component.get("components"), list):
            found = find_component(component["components"], key)

            if found:
                return found

    return None


def add_conversation_history(export, form_node_id, ui_tab_id, backend_tab_id):
    flows = export["flowsData"]["flows"]
    existing_ids = set(node["id"] for node in flows)

    form = find_node_by_id(flows, form_node_id)
    components = form["formStructure"]["components"]

    composer = find_component(components, "composer")

    if composer is None:
        raise KeyError("composer component not found")

    extract_response = find_node_by_name(flows, "Extract Response + Update Chat")

    # =====================================================
    # Frontend components
    # =====================================================

    picker_id = unique_id(existing_ids)
    tray_host_id = unique_id(existing_ids)
    attachment_bar_id = unique_id(existing_ids)

    attachment_picker = file_component(
        "attachmentPicker",
        "Attach files",
        SUPPORTED_EXTENSIONS,
        picker_id,
    )

    attachment_tray_host = htmlelement_component(
        "attachmentTrayHost",
        "Attachment Tray",
        ATTACHMENT_TRAY_HTML,
        tray_host_id,
    )

    attachment_bar = container_component(
        "attachmentBar",
        "Attachment Bar",
        "sca-attachment-bar-host",
        [attachment_picker, attachment_tray_host],
        attachment_bar_id,
    )

    composer["components"].append(attachment_bar)

    sidebar_header_id = unique_id(existing_ids)
    sidebar_header = htmlelement_component(
        "sidebarHeaderHtml",
        "Sidebar Header",
        SIDEBAR_HEADER_HTML,
        sidebar_header_id,
        class_name="sca-sidebar-header-host",
    )

    title_field_id = unique_id(existing_ids)
    updated_field_id = unique_id(existing_ids)
    open_button_id = unique_id(existing_ids)
    delete_button_id = unique_id(existing_ids)
    columns_id = unique_id(existing_ids)
    grid_id = unique_id(existing_ids)

    title_field = readonly_textfield_component("title", "Title", title_field_id)
    updated_field = readonly_textfield_component(
        "updatedAtLabel", "Updated", updated_field_id
    )

    open_button = button_component(
        "open",
        "",
        open_button_id,
        theme="primary",
        left_icon="fa fa-comment-dots",
        custom_class="w-100",
    )

    delete_button = button_component(
        "delete",
        "",
        delete_button_id,
        theme="secondary",
        left_icon="fa fa-trash",
        custom_class="w-100",
    )

    row_columns = columns_component(
        [(open_button, 6), (delete_button, 6)], columns_id
    )

    conversations_grid = datagrid_component(
        "conversationsGrid",
        "Conversations",
        [title_field, updated_field, row_columns],
        grid_id,
    )

    sidebar_panel_id = unique_id(existing_ids)
    sidebar_panel = container_component(
        "sidebarPanel",
        "Conversation History",
        "sca-sidebar-panel",
        [sidebar_header, conversations_grid],
        sidebar_panel_id,
    )

    # Inserted first so it reads first in the form's component order —
    # position in this array does not affect visual placement (that is
    # entirely CSS-driven, see history.css), only tab/reading order.
    components.insert(0, sidebar_panel)

    load_conversations_id = unique_id(existing_ids)
    load_conversations_button = button_component(
        "loadConversations",
        "Load Conversations",
        load_conversations_id,
        theme="secondary",
        action="submit",
    )

    components.append(load_conversations_button)

    # =====================================================
    # Outer `buttons` array + outputs/wires
    #
    # See docs/CHAT-HISTORY.md for why this order (existing three
    # buttons untouched at indices 0-2, three new ones appended at
    # 3-5, one fresh reserved output at 6) is believed to be how this
    # platform maps declared + datagrid-hoisted buttons to numbered
    # outputs — inferred from a colleague's working export, not
    # documented anywhere accessible here.
    # =====================================================

    form["buttons"].append(
        {
            "label": "Load Conversations",
            "action": "submit",
            "key": "loadConversations",
            "type": "button",
        }
    )
    form["buttons"].append({"label": "", "action": "submit", "key": "open", "type": "button"})
    form["buttons"].append(
        {"label": "", "action": "submit", "key": "delete", "type": "button"}
    )

    if form["outputs"] != 4 or len(form["wires"]) != 4:
        raise RuntimeError(
            "form outputs/wires shape changed since this was written — "
            "the output-index assumptions below need re-verifying"
        )

    form["outputs"] = 7

    # =====================================================
    # Backend nodes
    # =====================================================

    def fn(name, body, x=400, y=100, wires=None):
        node_id = unique_id(existing_ids)
        node = function_node(
            node_id, name, backend_tab_id, body, wires if wires is not None else [[]], x, y
        )
        flows.append(node)
        return node

    # --- CVP: persist every turn (tapped off the existing reply path) ---

    persist_fn = fn(
        "Prepare Conversation Persist",
        _read_backend_function("PREPARE_CONVERSATION_PERSIST"),
        x=1180,
        y=680,
    )

    persist_node_id = unique_id(existing_ids)
    persist_node = nosql_persist_node(
        persist_node_id, backend_tab_id, COLLECTION, x=1360, y=680, wires=[[]]
    )
    flows.append(persist_node)

    persist_fn["wires"] = [[persist_node_id]]

    # Tap: append to the EXISTING wire target list, don't replace it.
    extract_response["wires"][0].append(persist_fn["id"])

    # --- CVL: list (reused by both the explicit list trigger and delete) ---

    list_query_fn = fn(
        "Prepare Conversation List Query",
        _read_backend_function("PREPARE_CONVERSATION_LIST_QUERY"),
        x=780,
        y=780,
    )

    query_node_id = unique_id(existing_ids)
    query_node = nosql_query_node(
        query_node_id,
        backend_tab_id,
        COLLECTION,
        "submission.conversationsRaw",
        x=1000,
        y=780,
        wires=[[]],
        sort_property={"data.updatedAt": -1},
    )
    flows.append(query_node)

    list_query_fn["wires"] = [[query_node_id]]

    apply_list_fn = fn(
        "Apply Conversation List",
        _read_backend_function("APPLY_CONVERSATION_LIST"),
        x=1220,
        y=780,
    )

    query_node["wires"] = [[apply_list_fn["id"]]]

    refresh_sidebar_id = unique_id(existing_ids)
    refresh_sidebar = view_action_update_node(
        refresh_sidebar_id, "Refresh Conversations Sidebar", backend_tab_id, x=1440, y=780
    )
    flows.append(refresh_sidebar)

    apply_list_fn["wires"] = [[refresh_sidebar_id]]

    list_link_in_id = unique_id(existing_ids)
    list_link_in = link_in_node(
        list_link_in_id,
        "SAP List Conversations",
        backend_tab_id,
        None,  # filled in below once the UI-side link out id is known
        [[list_query_fn["id"]]],
        x=600,
        y=780,
    )
    flows.append(list_link_in)

    list_link_out_id = unique_id(existing_ids)
    list_link_out = link_out_node(
        list_link_out_id, "SAP List Conversations", ui_tab_id, list_link_in_id, x=680, y=760
    )
    flows.append(list_link_out)

    list_link_in["links"] = [list_link_out_id]

    # --- CVO: load a selected conversation ---

    get_selected_fn = fn(
        "Get Selected Conversation Id",
        _read_backend_function("GET_SELECTED_CONVERSATION_ID"),
        x=780,
        y=860,
    )

    find_one_node_id = unique_id(existing_ids)
    find_one_node = nosql_find_one_node(
        find_one_node_id,
        backend_tab_id,
        COLLECTION,
        "payload.data",
        x=1000,
        y=860,
        wires=[[]],
    )
    flows.append(find_one_node)

    get_selected_fn["wires"] = [[find_one_node_id]]

    apply_loaded_fn = fn(
        "Apply Loaded Conversation",
        _read_backend_function("APPLY_LOADED_CONVERSATION"),
        x=1220,
        y=860,
    )

    find_one_node["wires"] = [[apply_loaded_fn["id"]]]

    refresh_after_load_id = unique_id(existing_ids)
    refresh_after_load = view_action_update_node(
        refresh_after_load_id, "Refresh Chat After Load", backend_tab_id, x=1440, y=860
    )
    flows.append(refresh_after_load)

    apply_loaded_fn["wires"] = [[refresh_after_load_id]]

    load_link_in_id = unique_id(existing_ids)
    load_link_in = link_in_node(
        load_link_in_id,
        "SAP Load Conversation",
        backend_tab_id,
        None,
        [[get_selected_fn["id"]]],
        x=600,
        y=860,
    )
    flows.append(load_link_in)

    load_link_out_id = unique_id(existing_ids)
    load_link_out = link_out_node(
        load_link_out_id, "SAP Load Conversation", ui_tab_id, load_link_in_id, x=680, y=840
    )
    flows.append(load_link_out)

    load_link_in["links"] = [load_link_out_id]

    # --- CVD: delete a conversation, then re-run the SAME list chain ---

    get_delete_fn = fn(
        "Get Delete Conversation Id",
        _read_backend_function("GET_DELETE_CONVERSATION_ID"),
        x=780,
        y=940,
    )

    remove_node_id = unique_id(existing_ids)
    remove_node = nosql_remove_node(
        remove_node_id, backend_tab_id, COLLECTION, x=1000, y=940, wires=[[]]
    )
    flows.append(remove_node)

    get_delete_fn["wires"] = [[remove_node_id]]

    # Reuses the list chain built above instead of duplicating it.
    remove_node["wires"] = [[list_query_fn["id"]]]

    delete_link_in_id = unique_id(existing_ids)
    delete_link_in = link_in_node(
        delete_link_in_id,
        "SAP Delete Conversation",
        backend_tab_id,
        None,
        [[get_delete_fn["id"]]],
        x=600,
        y=940,
    )
    flows.append(delete_link_in)

    delete_link_out_id = unique_id(existing_ids)
    delete_link_out = link_out_node(
        delete_link_out_id,
        "SAP Delete Conversation",
        ui_tab_id,
        delete_link_in_id,
        x=680,
        y=920,
    )
    flows.append(delete_link_out)

    delete_link_in["links"] = [delete_link_out_id]

    # =====================================================
    # Wire the form's new outputs to the UI-tab link-out nodes
    #
    # form["wires"] indices: 0=newChat 1=sendMessage 2=submit (untouched)
    #                         3=loadConversations 4=open 5=delete
    #                         6=[] (fresh reserved output)
    #
    # Index 3 already exists (it was the old reserved/spare slot,
    # carrying only a debug node) and now belongs to loadConversations,
    # the 4th declared button — so it is REPLACED, not appended after;
    # only indices 4-6 are genuinely new.
    # =====================================================

    if len(form["wires"]) != 4:
        raise RuntimeError("form wires shape changed since this was written")

    form["wires"][3] = form["wires"][3] + [list_link_out_id]
    form["wires"].append([load_link_out_id])
    form["wires"].append([delete_link_out_id])
    form["wires"].append([])

    if len(form["wires"]) != form["outputs"]:
        raise RuntimeError(
            "wires/outputs count mismatch after wiring: "
            + str(len(form["wires"]))
            + " vs "
            + str(form["outputs"])
        )

    return {"collection": COLLECTION}
