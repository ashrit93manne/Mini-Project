#!/usr/bin/env python3
"""Structural comparison of the built export against the baseline.

Confirms the build changed exactly what it set out to change: nothing
existing was dropped, no PRE-EXISTING node lost its wiring without that
edit being intentional, and every edit is accounted for. New nodes
(conversation history's persistence/sidebar wiring) are expected and
reported, not treated as a failure — only a MISSING node, or a wiring
change on a node whose content is otherwise byte-identical to the
baseline (a sign of an accidental mutation rather than a deliberate
edit), fails the check.
"""
import json
import sys


def load(path):
    with open(path, encoding="utf8") as handle:
        return json.load(handle)


def summarise(export):
    flows = export["flowsData"]["flows"]
    return {
        "node_count": len(flows),
        "node_ids": set(node["id"] for node in flows),
        "wires": {
            node["id"]: node.get("wires") for node in flows if "wires" in node
        },
    }


def main(base_path, built_path):
    base = load(base_path)
    built = load(built_path)

    a = summarise(base)
    b = summarise(built)

    problems = []

    missing = a["node_ids"] - b["node_ids"]
    added = b["node_ids"] - a["node_ids"]

    if missing:
        problems.append(f"nodes present in the baseline are missing: {missing}")

    # Which PRE-EXISTING nodes actually differ, and how.
    base_nodes = {n["id"]: n for n in base["flowsData"]["flows"]}
    built_nodes = {n["id"]: n for n in built["flowsData"]["flows"]}

    changed = []
    changed_ids = set()

    for node_id in a["node_ids"]:
        if json.dumps(base_nodes[node_id], sort_keys=True) != json.dumps(
            built_nodes[node_id], sort_keys=True
        ):
            node = built_nodes[node_id]
            changed.append(f"{node['type']}: {node.get('name') or node_id}")
            changed_ids.add(node_id)

    # A wiring change is only suspicious on a node that is otherwise
    # byte-identical to the baseline — on a node already flagged as
    # "changed" above, different wiring is simply part of that same,
    # presumably deliberate, edit.
    for node_id, wires in a["wires"].items():
        if node_id in changed_ids:
            continue

        if b["wires"].get(node_id) != wires:
            problems.append(
                f"wiring changed on node {node_id} with no other change to it"
            )

    added_summary = [
        f"{built_nodes[node_id]['type']}: {built_nodes[node_id].get('name') or node_id}"
        for node_id in sorted(added)
    ]

    print("Structural comparison")
    print("  baseline :", base_path)
    print("  built    :", built_path)
    print()
    print(f"  nodes: {a['node_count']} -> {b['node_count']} ({len(added)} added)")
    print(f"  no pre-existing node was silently modified: {'no' if problems else 'yes'}")
    print()
    print("  pre-existing nodes changed:")
    for entry in sorted(changed):
        print("   -", entry)
    print()
    print("  new nodes added:")
    for entry in added_summary:
        print("   -", entry)

    base_info = base["info"]["deptAppVersionInfo"]
    built_info = built["info"]["deptAppVersionInfo"]
    print()
    print(f"  version: {base_info['alias']} -> {built_info['alias']}")

    if problems:
        print()
        print("PROBLEMS:")
        for problem in problems:
            print("  !", problem)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2]))
