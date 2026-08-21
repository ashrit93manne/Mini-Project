"""
Adds the FAQ layer to the RAG workflow.

    BM25 Rank + Build RAG Context
      -> Prepare FAQ Lookup
      -> Load FAQ Entries        (nosql-query, collection "sca-faqs")
      -> Match FAQ + Ground
      -> Validate + Build SAP Agent Prompt

Curated question/answer pairs are retrieved and ranked exactly the way
attachment chunks already are, and injected as grounding ahead of the
developer's request. There is no vector database and no embedding call:
the NoSQL module is confirmed present on this platform, and a curated
FAQ set is tens of entries rather than millions, so lexical ranking is
both sufficient and far easier to reason about when an answer looks
wrong.

Two safety properties this must not break:

  * The FAQ never answers on the model's behalf. A canned reply would
    drift out of step with the four-stage workflow and make the
    assistant sound scripted. What the FAQ contributes is a house
    answer for the model to follow.
  * A failure here must not cost the developer their turn. Both
    function nodes are wrapped fail-open, and Check err's CER-01B
    bypass (tools/rag_hardening.py) routes a failure of the nosql-query
    node back to the prompt builder rather than to a user-facing error.
    That matters most on first use, before anyone has created the
    collection.

The query node is CLONED from the RAG one already in the export rather
than constructed from scratch, so its shape cannot drift from a
configuration the platform is known to accept.
"""

import copy
import json
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

COLLECTION = "sca-faqs"


class FaqLayerError(RuntimeError):
    pass


def _read_backend_function(export_name):
    """Pulls one export out of src/backend/faq-functions.js under Node."""
    script = (
        "const fns = require(%r);"
        "process.stdout.write(JSON.stringify(fns[%r]));"
    ) % (
        os.path.join(ROOT, "src", "backend", "faq-functions.js"),
        export_name,
    )

    result = subprocess.run(
        ["node", "-e", script], capture_output=True, text=True, check=True
    )

    return json.loads(result.stdout)


def _find(flows, name):
    for node in flows:
        if node.get("name") == name:
            return node

    raise FaqLayerError("node not found: " + name)


def _new_ids(flows, count):
    """Deterministic ids that cannot collide with anything present."""
    existing = {node.get("id") for node in flows}
    ids = []
    index = 0

    while len(ids) < count:
        candidate = "fa9" + format(index, "013x")

        if candidate not in existing:
            ids.append(candidate)
            existing.add(candidate)

        index += 1

    return ids


PROMPT_ANCHOR = """  const userReferenceContext =
    retrievedAttachmentContext ||
    attachmentsText;"""

PROMPT_REPLACEMENT = """  /*
   * Curated FAQ guidance, when the question matched one. It goes ahead
   * of any document context: it is the house position on the question,
   * whereas the document is material for answering it.
   */
  const faqGuidanceContext =
    typeof msg.faqContextText === "string"
      ? msg.faqContextText.trim()
      : "";

  const userReferenceContext =
    [
      faqGuidanceContext,
      retrievedAttachmentContext ||
        attachmentsText
    ]
      .filter(
        function (part) {
          return part;
        }
      )
      .join("\\n\\n");"""


def add_faq_layer(export):
    """Inserts the FAQ chain. Idempotent."""
    flows = export["flowsData"]["flows"]

    if any(node.get("name") == "Match FAQ + Ground" for node in flows):
        return export

    rank = _find(flows, "BM25 Rank + Build RAG Context")
    validate = _find(flows, "Validate + Build SAP Agent Prompt")
    rag_query = _find(flows, "Load Conversation RAG Chunks")

    lookup_id, query_id, match_id = _new_ids(flows, 3)

    tab = rank["z"]

    # ---- the query node, cloned from the working RAG one ------------
    query = copy.deepcopy(rag_query)

    query.update(
        {
            "id": query_id,
            "z": tab,
            "name": "Load FAQ Entries",
            "collectionProperty": COLLECTION,
            "searchFilterProperty": "faqSearchFilter",
            "bindingProperty": "faqCandidates",
            "pageNumberProperty": "faqPaginator.pageNumber",
            "itemsPerPageProperty": "faqPaginator.itemsPerPage",
            "x": rank.get("x", 400) + 220,
            "y": rank.get("y", 100) + 120,
            "wires": [[match_id]],
        }
    )

    if "totalItemsCountProperty" in query:
        query["totalItemsCountProperty"] = "faqPaginator.totalResults"

    # ---- the two function nodes -------------------------------------
    def function_node(node_id, name, body, wires, offset):
        return {
            "id": node_id,
            "type": "function",
            "z": tab,
            "name": name,
            "func": body,
            "outputs": 1,
            "setupErrors": None,
            "functionErrors": None,
            "closeErrors": None,
            "initialize": "",
            "finalize": "",
            "x": rank.get("x", 400) + offset,
            "y": rank.get("y", 100) + 120,
            "wires": wires,
        }

    lookup = function_node(
        lookup_id,
        "Prepare FAQ Lookup",
        _read_backend_function("PREPARE_FAQ_LOOKUP"),
        [[query_id]],
        60,
    )

    match = function_node(
        match_id,
        "Match FAQ + Ground",
        _read_backend_function("MATCH_FAQ_AND_GROUND"),
        [[validate["id"]]],
        380,
    )

    # ---- rewire BM25 -> FAQ chain -> prompt builder -----------------
    rewired = False

    for wire in rank.get("wires") or []:
        for index, target in enumerate(wire):
            if target == validate["id"]:
                wire[index] = lookup_id
                rewired = True

    if not rewired:
        raise FaqLayerError(
            "BM25 Rank + Build RAG Context does not feed the prompt "
            "builder; the chat path is not shaped as expected"
        )

    flows.extend([lookup, query, match])

    # ---- the new nodes belong to the same catch scope ---------------
    for node in flows:
        if node.get("type") == "catch" and isinstance(node.get("scope"), list):
            for node_id in (lookup_id, query_id, match_id):
                if node_id not in node["scope"]:
                    node["scope"].append(node_id)

    # ---- the prompt builder has to actually use the guidance --------
    func = validate["func"]

    if PROMPT_ANCHOR not in func:
        raise FaqLayerError(
            "Validate + Build SAP Agent Prompt: user-turn anchor not found"
        )

    if func.count(PROMPT_ANCHOR) != 1:
        raise FaqLayerError(
            "Validate + Build SAP Agent Prompt: user-turn anchor is not unique"
        )

    validate["func"] = func.replace(PROMPT_ANCHOR, PROMPT_REPLACEMENT, 1)

    return export
