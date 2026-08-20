"""
Node-RED / axetflows node constructors used by build_deptapp.py.

Unlike the anchored text patches in build_deptapp.py (which edit EXISTING
function bodies), the conversation-history feature adds entirely NEW
graph nodes — buttons, a datagrid, NoSQL operations, link in/out pairs.
Text-patching doesn't fit that: there is no existing anchor to attach to.
These are built as plain Python dicts instead and appended to
flowsData.flows, with ids generated once and wired explicitly.

Every shape here is copied from a node type that is DEMONSTRATED WORKING
in one of two places:
  - this repository's OWN baseline export (function, link in/out,
    axetflows-view-action, axetflows-form buttons/outputs), or
  - a colleague's separately-exported, in-production aXet.flows app
    (nosql-persist/query/find-one/remove, datagrid with row-action
    buttons, the button-hoisting-into-outputs convention).

The one component type neither reference app happens to use is Form.io's
`file` component (attachmentPicker below). Its shape is Form.io's own
long-stable default file-component schema — not something this platform
could plausibly have altered, since aXet.flows appears to be a thin
Node-RED + Form.io wrapper rather than a fork of either — but it is the
one piece of this file without a directly observed precedent, and is
called out as such in docs/CHAT-HISTORY.md.
"""
import secrets


def new_id():
    """16 lowercase hex characters, matching every id already in the export."""
    return secrets.token_hex(8)


def unique_id(existing_ids):
    node_id = new_id()

    while node_id in existing_ids:
        node_id = new_id()

    existing_ids.add(node_id)

    return node_id


# =========================================================
# Shared boilerplate
#
# Every Form.io component in both reference exports carries this same
# long tail of fields regardless of type. Reproducing it exactly (rather
# than guessing which subset matters) is the safest way to add a
# component this platform's builder didn't itself generate.
# =========================================================

def _component_boilerplate(component_id):
    return {
        "tags": [],
        "properties": {},
        "conditional": {"show": None, "when": None, "eq": "", "json": ""},
        "customConditional": "",
        "logic": [],
        "attributes": {},
        "overlay": {
            "style": "",
            "page": "",
            "left": "",
            "top": "",
            "width": "",
            "height": "",
        },
        "allowCalculateOverride": False,
        "encrypted": False,
        "showCharCount": False,
        "showWordCount": False,
        "allowMultipleMasks": False,
        "id": component_id,
    }


def _validate_block(required=False):
    return {
        "required": required,
        "pattern": "",
        "customMessage": "",
        "custom": "",
        "customPrivate": False,
        "json": "",
        "minLength": "",
        "maxLength": "",
        "strictDateValidation": False,
        "multiple": False,
        "unique": False,
    }


# =========================================================
# Form components
# =========================================================


def container_component(key, label, custom_class, children, component_id):
    """A `container` component, matching the existing `composer` shape."""
    node = {
        "label": label,
        "labelPosition": "top",
        "tooltip": "",
        "customClass": custom_class,
        "hidden": False,
        "hideLabel": True,
        "disabled": False,
        "tableView": False,
        "modalEdit": False,
        "persistent": True,
        "protected": False,
        "dbIndex": False,
        "redrawOn": "",
        "clearOnHide": True,
        "customDefaultValue": "",
        "calculateValue": "",
        "validate": _validate_block(),
        "unique": False,
        "validateOn": "change",
        "errorLabel": "",
        "key": key,
        "type": "container",
        "input": True,
        "components": children,
        "path": key,
        "placeholder": "",
        "prefix": "",
        "suffix": "",
        "multiple": False,
        "defaultValue": None,
        "refreshOn": "",
        "description": "",
        "tabindex": "",
        "autofocus": False,
        "widget": None,
        "tree": True,
    }
    node.update(_component_boilerplate(component_id))
    return node


def htmlelement_component(key, label, content, component_id, tag="div", class_name=""):
    return {
        "label": label,
        "tag": tag,
        "className": class_name,
        "attrs": [{"attr": "", "value": ""}],
        "content": content,
        "refreshOnChange": False,
        "customClass": "",
        "hidden": False,
        "tableView": False,
        "modalEdit": False,
        "key": key,
        "type": "htmlelement",
        "input": False,
        "validate": _validate_block(),
        "placeholder": "",
        "prefix": "",
        "suffix": "",
        "multiple": False,
        "defaultValue": None,
        "protected": False,
        "unique": False,
        "persistent": False,
        "clearOnHide": True,
        "refreshOn": "",
        "redrawOn": "",
        "labelPosition": "top",
        "description": "",
        "errorLabel": "",
        "hideLabel": False,
        "tabindex": "",
        "disabled": False,
        "autofocus": False,
        "dbIndex": False,
        "customDefaultValue": "",
        "calculateValue": "",
        "widget": None,
        "validateOn": "change",
        **_component_boilerplate(component_id),
    }


def file_component(key, label, filenames, component_id, max_files=5, max_size_mb=10):
    """
    Form.io's standard `file` component, storage: base64 (no server
    upload, no persistence — matches the product's "no server storage"
    boundary already documented for text/PDF/Word attachments).

    See the module docstring: this is the one shape here without a
    directly observed precedent in either reference export.
    """
    return {
        "label": label,
        "labelPosition": "top",
        "description": "",
        "tooltip": "",
        "customClass": "",
        "tabindex": "",
        "hidden": False,
        "hideLabel": True,
        "autofocus": False,
        "disabled": False,
        "tableView": False,
        "modalEdit": False,
        "multiple": True,
        "persistent": True,
        "protected": False,
        "dbIndex": False,
        "encrypted": False,
        "redrawOn": "",
        "clearOnHide": True,
        "customDefaultValue": "",
        "calculateValue": "",
        "calculateServer": False,
        "validateOn": "change",
        "validate": _validate_block(),
        "unique": False,
        "errorLabel": "",
        "key": key,
        "type": "file",
        "input": True,
        "storage": "base64",
        "url": "",
        "options": "",
        "fileNameTemplate": "",
        "image": False,
        "webcam": False,
        "webcamSize": 320,
        "capture": "",
        "fileTypes": [{"label": "", "value": ""}],
        "filePattern": ",".join(filenames),
        "fileMinSize": "0KB",
        "fileMaxSize": str(max_size_mb) + "MB",
        "uploadOnly": False,
        "placeholder": "",
        "prefix": "",
        "suffix": "",
        "defaultValue": None,
        "refreshOn": "",
        "widget": None,
        **_component_boilerplate(component_id),
    }


def button_component(
    key,
    label,
    component_id,
    theme="secondary",
    left_icon="",
    action="submit",
    custom_class="",
    hidden=False,
):
    return {
        "label": label,
        "action": action,
        "showValidations": False,
        "theme": theme,
        "size": "md",
        "block": False,
        "leftIcon": left_icon,
        "rightIcon": "",
        "shortcut": "",
        "description": "",
        "tooltip": "",
        "customClass": custom_class,
        "tabindex": "",
        "disableOnInvalid": False,
        "hidden": hidden,
        "autofocus": False,
        "disabled": False,
        "tableView": False,
        "modalEdit": False,
        "key": key,
        "type": "button",
        "input": True,
        "validate": _validate_block(),
        "placeholder": "",
        "prefix": "",
        "suffix": "",
        "multiple": False,
        "defaultValue": None,
        "protected": False,
        "unique": False,
        "persistent": False,
        "clearOnHide": True,
        "refreshOn": "",
        "redrawOn": "",
        "labelPosition": "top",
        "errorLabel": "",
        "hideLabel": False,
        "dbIndex": False,
        "customDefaultValue": "",
        "calculateValue": "",
        "widget": {"type": "input"},
        "validateOn": "change",
        "dataGridLabel": True,
        **_component_boilerplate(component_id),
    }


def readonly_textfield_component(key, label, component_id):
    """A disabled, display-only text field — the datagrid row-cell shape."""
    return {
        "label": label,
        "spellcheck": True,
        "tableView": True,
        "key": key,
        "type": "textfield",
        "input": True,
        "defaultValue": None,
        "placeholder": "",
        "prefix": "",
        "customClass": "",
        "suffix": "",
        "multiple": False,
        "protected": False,
        "unique": False,
        "persistent": True,
        "hidden": False,
        "clearOnHide": True,
        "refreshOn": "",
        "redrawOn": "",
        "modalEdit": False,
        "labelPosition": "top",
        "description": "",
        "errorLabel": "",
        "tooltip": "",
        "hideLabel": True,
        "tabindex": "",
        "disabled": True,
        "autofocus": False,
        "dbIndex": False,
        "customDefaultValue": "",
        "calculateValue": "",
        "validateOn": "change",
        "mask": False,
        "inputType": "text",
        "inputFormat": "plain",
        "inputMask": "",
        "validate": _validate_block(),
        **_component_boilerplate(component_id),
    }


def datagrid_row_button(key, label, theme, left_icon, component_id):
    button = button_component(
        key, label, component_id, theme=theme, left_icon=left_icon, custom_class="w-100"
    )
    return button


def columns_component(pairs, component_id):
    """
    pairs: list of (component, width) tuples, one Form.io `columns`
    entry per pair, matching the row-action layout used for the edit/
    delete buttons in the reference admin screen.
    """
    return {
        "label": " ",
        "columns": [{"components": [component], "width": width} for component, width in pairs],
        "tableView": False,
        "key": "columns",
        "type": "columns",
        "input": False,
        "placeholder": "",
        "prefix": "",
        "customClass": "",
        "suffix": "",
        "multiple": False,
        "defaultValue": None,
        "protected": False,
        "unique": False,
        "persistent": False,
        "hidden": False,
        "clearOnHide": False,
        "redrawOn": "",
        "modalEdit": False,
        "labelPosition": "top",
        "description": "",
        "errorLabel": "",
        "hideLabel": False,
        "tabindex": "",
        "disabled": False,
        "autofocus": False,
        "dbIndex": False,
        "customDefaultValue": "",
        "calculateValue": "",
        "validateOn": "change",
        "validate": _validate_block(),
        "tree": False,
        "autoAdjust": False,
        "hideOnChildrenHidden": False,
        **_component_boilerplate(component_id),
    }


def datagrid_component(key, label, children, component_id):
    return {
        "label": label,
        "disableAddingRemovingRows": True,
        "reorder": False,
        "addAnotherPosition": "bottom",
        "defaultOpen": False,
        "layoutFixed": False,
        "enableRowGroups": False,
        "tableView": False,
        "validate": _validate_block(),
        "key": key,
        "type": "datagrid",
        "input": True,
        "components": children,
        "placeholder": "",
        "prefix": "",
        "customClass": "",
        "suffix": "",
        "multiple": False,
        "defaultValue": [],
        "protected": False,
        "unique": False,
        "persistent": True,
        "hidden": False,
        "clearOnHide": True,
        "redrawOn": "",
        "modalEdit": False,
        "labelPosition": "top",
        "description": "",
        "errorLabel": "",
        "hideLabel": True,
        "tabindex": "",
        "disabled": False,
        "autofocus": False,
        "dbIndex": False,
        "customDefaultValue": "",
        "calculateValue": "",
        "validateOn": "change",
        "tree": True,
        **_component_boilerplate(component_id),
    }


# =========================================================
# Flow nodes
# =========================================================


def function_node(node_id, name, z, func, wires, x=400, y=100):
    return {
        "id": node_id,
        "type": "function",
        "z": z,
        "name": name,
        "func": func,
        "outputs": 1,
        "setupErrors": None,
        "functionErrors": None,
        "closeErrors": None,
        "initialize": "",
        "finalize": "",
        "x": x,
        "y": y,
        "wires": wires,
    }


def link_out_node(node_id, name, z, target_id, x=400, y=100):
    return {
        "id": node_id,
        "type": "link out",
        "z": z,
        "name": name,
        "mode": "link",
        "links": [target_id],
        "x": x,
        "y": y,
        "wires": [],
    }


def link_in_node(node_id, name, z, source_id, wires, x=400, y=100):
    return {
        "id": node_id,
        "type": "link in",
        "z": z,
        "name": name,
        "links": [source_id],
        "x": x,
        "y": y,
        "wires": wires,
    }


def view_action_update_node(node_id, name, z, x=400, y=100):
    return {
        "id": node_id,
        "type": "axetflows-view-action",
        "z": z,
        "name": name,
        "action": "update",
        "redirectPage": None,
        "downloadFile": False,
        "fileName": "",
        "inputType": "buffer",
        "message": "",
        "messageType": "info",
        "x": x,
        "y": y,
        "wires": [],
    }


def nosql_persist_node(node_id, z, collection, x=400, y=100, wires=None):
    return {
        "id": node_id,
        "type": "nosql-persist",
        "z": z,
        "name": None,
        "dbNameIsBlockByAutogeneration": True,
        "collectionProperty": collection,
        "collectionPropertyType": "str",
        "property": "submission",
        "propertyType": "msg",
        "x": x,
        "y": y,
        "wires": wires if wires is not None else [[]],
    }


def nosql_query_node(
    node_id,
    z,
    collection,
    binding_property,
    x=400,
    y=100,
    wires=None,
    sort_property=None,
):
    node = {
        "id": node_id,
        "type": "nosql-query",
        "z": z,
        "name": None,
        "dbNameIsBlockByAutogeneration": True,
        "collectionProperty": collection,
        "collectionPropertyType": "str",
        "sort": bool(sort_property),
        "paginator": True,
        "searchFilterProperty": "submission.searchFilterContainer",
        "searchFilterPropertyType": "msg",
        "bindingProperty": binding_property,
        "bindingPropertyType": "msg",
        "sortProperty": sort_property or {},
        "sortPropertyType": "json",
        "pageNumberProperty": "submission.paginator.pageNumber",
        "pageNumberPropertyType": "msg",
        "itemsPerPageProperty": "submission.paginator.itemsPerPage",
        "itemsPerPagePropertyType": "msg",
        "totalItemsCountProperty": "submission.paginator.totalResults",
        "totalItemsCountPropertyType": "msg",
        "x": x,
        "y": y,
        "wires": wires if wires is not None else [[]],
    }
    return node


def nosql_find_one_node(node_id, z, collection, binding_property, x=400, y=100, wires=None):
    return {
        "id": node_id,
        "type": "nosql-find-one",
        "z": z,
        "name": None,
        "collectionProperty": collection,
        "collectionPropertyType": "str",
        "identifierProperty": "_id",
        "identifierPropertyType": "msg",
        "bindingProperty": binding_property,
        "bindingPropertyType": "msg",
        "x": x,
        "y": y,
        "wires": wires if wires is not None else [[]],
    }


def nosql_remove_node(node_id, z, collection, x=400, y=100, wires=None):
    return {
        "id": node_id,
        "type": "nosql-remove",
        "z": z,
        "name": None,
        "dbNameIsBlockByAutogeneration": True,
        "collectionProperty": collection,
        "collectionPropertyType": "str",
        "property": "_id",
        "propertyType": "msg",
        "x": x,
        "y": y,
        "wires": wires if wires is not None else [[]],
    }
