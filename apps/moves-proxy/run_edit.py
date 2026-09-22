"""
Manual runner: apply a verified change to a Moves Management action plan.

Usage (ids come from the tools, never hardcoded here -- this repo is public):

    browser-harness -c "$(cat run_edit.py)" -- \
        --contact EID0A1B2C --plan EID4321Z --van-id 100000000 \
        --set status=Cultivation --set status_date=2026-09-10

Add --apply to actually save; without it this is a dry run that changes nothing.

Find the ids first:
    browser-harness -c 'import sys; sys.path.insert(0, ".")
    import ea_moves as m, json
    print(json.dumps(m.find_contact("lastname")))
    print(json.dumps(m.plan_eids("<contact eid>")))'
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ea_moves as m  # noqa: E402


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Update an EveryAction action plan.")
    ap.add_argument("--contact", required=True, help="contact EID, e.g. EID0A1B2C")
    ap.add_argument("--plan", required=True, help="plan EID from plan_eids()")
    ap.add_argument("--van-id", required=True, type=int)
    ap.add_argument("--set", action="append", default=[], metavar="FIELD=VALUE",
                    help="repeatable, e.g. --set status=Cultivation")
    ap.add_argument("--apply", action="store_true", help="save (default is a dry run)")
    args = ap.parse_args(argv)

    changes = {}
    for pair in args.set:
        if "=" not in pair:
            ap.error(f"--set expects FIELD=VALUE, got {pair!r}")
        field, value = pair.split("=", 1)
        changes[field.strip()] = value.strip()
    if not changes:
        ap.error("nothing to change -- pass at least one --set FIELD=VALUE")

    before = m.find_plan(args.contact, args.van_id, args.plan)
    print("BEFORE:", json.dumps(m.summarize_plan(before)) if before else "plan not found")

    result = m.update_plan(args.contact, args.plan, args.van_id,
                           dry_run=not args.apply, **changes)
    print("\nRESULT:")
    print(json.dumps(result, indent=1))

    if args.apply and not result.get("verified"):
        print("\nNOT SAVED. EveryAction did not store the requested values.")
        print("validators:", json.dumps(result.get("validation_errors")))
        return 1
    return 0


if __name__ == "__main__":
    argv = sys.argv[1:]
    if "--" in argv:                      # browser-harness -c '...' -- <args>
        argv = argv[argv.index("--") + 1:]
    raise SystemExit(main(argv))
