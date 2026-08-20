#!/usr/bin/env python3
"""Structural comparison of the built export against the baseline.

Confirms the build changed exactly what it set out to change: nothing
was dropped, no node lost its wiring, and every edit is accounted for.
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
        "node_ids": sorted(node["id"] for node in flows),
        "types": sorted(node["type"] for node in flows),
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

    if a["node_count"] != b["node_count"]:
        problems.append(
            f"node count changed: {a['node_count']} -> {b['node_count']}"
        )

    if a["node_ids"] != b["node_ids"]:
        missing = set(a["node_ids"]) - set(b["node_ids"])
        added = set(b["node_ids"]) - set(a["node_ids"])
        problems.append(f"node ids changed (missing={missing}, added={added})")

    if a["wires"] != b["wires"]:
        for node_id, wires in a["wires"].items():
            if b["wires"].get(node_id) != wires:
                problems.append(f"wiring changed on node {node_id}")

    # Which nodes actually differ, and why.
    base_nodes = {n["id"]: n for n in base["flowsData"]["flows"]}
    built_nodes = {n["id"]: n for n in built["flowsData"]["flows"]}

    changed = []
    for node_id in a["node_ids"]:
        if json.dumps(base_nodes[node_id], sort_keys=True) != json.dumps(
            built_nodes[node_id], sort_keys=True
        ):
            node = built_nodes[node_id]
            changed.append(f"{node['type']}: {node.get('name') or node_id}")

    print("Structural comparison")
    print("  baseline :", base_path)
    print("  built    :", built_path)
    print()
    print(f"  nodes: {a['node_count']} -> {b['node_count']}")
    print(f"  wiring preserved: {'no' if problems else 'yes'}")
    print()
    print("  changed nodes:")
    for entry in changed:
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
