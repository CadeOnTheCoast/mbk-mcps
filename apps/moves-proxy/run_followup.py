"""
Manual runner: schedule a follow-up, then verify it through the JSON API.

Usage (ids come from the tools, never hardcoded here -- this repo is public):

    browser-harness -c "$(cat run_followup.py)" -- \
        --contact EID0A1B2C --van-id 100000000 --date 2026-10-20 \
        --how Phone --priority High --notes "Discussing the ask" \
        --plan EID4321Z

Add --apply to actually save; without it this is a dry run that also prints the
valid options for every dropdown in your EveryAction instance.
"""

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ea_moves as m  # noqa: E402


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Schedule an EveryAction follow-up.")
    ap.add_argument("--contact", required=True, help="contact EID")
    ap.add_argument("--van-id", required=True, type=int)
    ap.add_argument("--date", required=True, help="YYYY-MM-DD")
    ap.add_argument("--how", default="Phone")
    ap.add_argument("--priority", default="Medium", choices=["High", "Medium", "Low"])
    ap.add_argument("--notes", default="")
    ap.add_argument("--note-category", default=None)
    ap.add_argument("--plan", default=None, help="plan EID to attach the follow-up to")
    ap.add_argument("--apply", action="store_true", help="save (default is a dry run)")
    args = ap.parse_args(argv)

    print("follow-ups BEFORE:", len(m.upcoming_followups(args.van_id)))

    result = m.schedule_followup(
        args.contact, args.van_id, date_=args.date, how=args.how,
        priority=args.priority, notes=args.notes,
        note_category=args.note_category, plan_eid=args.plan,
        dry_run=not args.apply,
    )

    print("\nRESULT:")
    print(json.dumps({k: v for k, v in result.items() if k != "options"}, indent=1))
    if not args.apply:
        print("\nvalid dropdown options:")
        print(json.dumps(result.get("options"), indent=1))
        return 0

    print("\nfollow-ups AFTER:", json.dumps(m.upcoming_followups(args.van_id), indent=1))
    return 0 if result.get("verified") else 1


if __name__ == "__main__":
    argv = sys.argv[1:]
    if "--" in argv:                      # browser-harness -c '...' -- <args>
        argv = argv[argv.index("--") + 1:]
    raise SystemExit(main(argv))
