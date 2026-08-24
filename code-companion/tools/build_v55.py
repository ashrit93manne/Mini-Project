"""
Builds v5.5.0 from the v5.4.0 export.

Different lineage from build_deptapp.py deliberately. v5.4.0 was built
elsewhere and already carries the v5.2.0 user interface plus its own
fast-route and retrieval-bypass work; re-running the v5.2.0 patch stack
over it would fail on anchors that have already been applied. So this
takes v5.4.0 as-is and changes only the chat path.

Usage:
    python3 tools/build_v55.py \\
      --base baseline/aXet.SAP__Code_Companion_v5.4.0_fast_RAG_reliability.deptapp \\
      --out  build/aXet.SAP__Code_Companion_v5.5.0_export.deptapp
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from chat_path_v55 import ChatPathError, fix_chat_path  # noqa: E402

FORM_NODE_ID = "21d415924e0e4841"

NEW_VERSION_ALIAS = "v5.5.0"

NEW_VERSION_MESSAGE = (
    "SAP Code Companion v5.5.0 - the agent answers again, and a "
    "conversation exists from the first prompt. v5.4.0 deleted "
    "msg.query before the Enabler on the assumption that messages-only "
    "is a valid input contract; the working v4.6.2 baseline always sent "
    "both, and with query removed no reply ever came back. Conversation "
    "history is now written when the prompt is SENT rather than only "
    "after a successful reply, titled from the user's own first "
    "message, and its owner falls back to an identity the browser "
    "supplies instead of being discarded when the flow cannot resolve "
    "one. require('crypto') is removed from the retrieval path again."
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    with open(args.base, encoding="utf8") as handle:
        export = json.load(handle)

    fix_chat_path(export, FORM_NODE_ID)

    info = export["info"]["deptAppVersionInfo"]
    info["alias"] = NEW_VERSION_ALIAS
    info["descriptionMessage"] = NEW_VERSION_MESSAGE

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)

    with open(args.out, "w", encoding="utf8") as handle:
        json.dump(export, handle, ensure_ascii=False, separators=(",", ":"))

    print(f"built {args.out} ({os.path.getsize(args.out):,} bytes)")
    print(f"  flow nodes  : {len(export['flowsData']['flows'])}")
    print(f"  version     : {NEW_VERSION_ALIAS}")


if __name__ == "__main__":
    try:
        main()
    except ChatPathError as error:
        print(f"BUILD FAILED\n{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
