"""
Moves Management MCP server.

Exposes EveryAction's Moves Management -- action plans and scheduled follow-ups
-- to Claude Desktop, working through the operator's own logged-in browser.

Why a local server instead of the hosted MCP
--------------------------------------------
EveryAction serves Moves Management from real /v4 routes that API-key auth is
not granted:

    /v4/contactRecords/{id}/actionPlans        -> 403 for an API key
    /v4/portfolioManagement/actionPlans/{id}   -> 403 for an API key

The same routes answer normally for a signed-in browser session. So this server
runs on the operator's machine and drives their existing EveryAction tab. There
are no credentials here and none are ever requested: if the session has lapsed,
tools say so and ask the person to sign in themselves.

A useful side effect is that every change is attributed to the real person in
EveryAction's audit trail, not to a shared service account.

Isolation
---------
Calls shell out to the `browser-harness` CLI rather than importing it, so this
server needs nothing in its environment beyond the MCP SDK and the harness on
PATH -- the two can be installed independently and neither can break the other.
"""

from __future__ import annotations

import functools
import json
import os
import shutil
import subprocess
import sys
from typing import Any

# The SDK renamed FastMCP to MCPServer in 2.x. The shape we use -- constructor,
# .tool() decorator, .run() defaulting to stdio -- is the same in both, so accept
# either rather than pinning an old SDK on someone's machine.
try:
    from mcp.server.mcpserver import MCPServer as _Server  # mcp >= 2
except ImportError:  # pragma: no cover
    from mcp.server.fastmcp import FastMCP as _Server      # mcp 1.x

# Self-locating: the modules sit beside this file, so the server works from any
# checkout path without editing. MOVES_PROXY_DIR overrides it if ever needed.
MOVES_DIR = os.environ.get(
    "MOVES_PROXY_DIR", os.path.dirname(os.path.abspath(__file__))
)
MARKER = "<<<MOVES_JSON>>>"
ERR_MARKER = "<<<MOVES_ERR>>>"
TIMEOUT_S = 240

server = _Server("everyaction-moves")


def _self_update() -> None:
    """
    Pull the latest version of this tool from its public repo before serving.

    Distribution is a git checkout (see install.sh), not a zip someone unpacked
    once, so a fix pushed upstream reaches every install the next time Claude
    Desktop starts this server -- nobody has to be sent a new file. This is
    best-effort and MUST NEVER be destructive or block startup: it uses
    `pull --ff-only`, which simply fails (doing nothing) against a dirty or
    diverged tree instead of discarding anything, and every step is wrapped so
    a missing git, no network, or a non-checkout install just skips silently.

    If the pull actually moved HEAD, os.execv re-runs the fresh file in place.
    execv keeps the process's existing stdio file descriptors, which is what
    Claude Desktop's MCP connection is built on, so the swap is invisible to
    it -- no dropped connection, no need for the person to restart anything.
    """
    try:
        def _git(*args: str, timeout: int = 8) -> subprocess.CompletedProcess:
            return subprocess.run(
                ["git", "-C", MOVES_DIR, *args],
                capture_output=True, text=True, timeout=timeout,
            )

        top = _git("rev-parse", "--show-toplevel", timeout=5)
        repo_root = top.stdout.strip()
        if top.returncode != 0 or not repo_root:
            return  # not a git checkout (e.g. a developer's ad-hoc setup)

        before = _git("rev-parse", "HEAD", timeout=5).stdout.strip()
        pulled = subprocess.run(
            ["git", "-C", repo_root, "pull", "--ff-only", "--quiet", "origin", "main"],
            capture_output=True, text=True, timeout=15,
        )
        if pulled.returncode != 0:
            return  # offline, dirty tree, or diverged -- leave it running as-is
        after = _git("rev-parse", "HEAD", timeout=5).stdout.strip()

        if after and after != before:
            os.execv(sys.executable, [sys.executable, os.path.abspath(__file__)])
    except Exception:
        pass  # never let an update check take down the server


class ProxyError(RuntimeError):
    pass


def _call(func: str, **kwargs: Any) -> Any:
    """Run one ea_moves function inside the harness and return its JSON result."""
    if not shutil.which("browser-harness"):
        raise ProxyError(
            "browser-harness is not installed or not on PATH. Run the installer in "
            "apps/moves-proxy/install.sh, then restart Claude."
        )

    payload = json.dumps(kwargs)
    # The child reports its own failures as structured data. Parsing tracebacks
    # from stderr does not work: an exception message that spans lines (an API
    # error carrying a JSON body, say) leaves the last line as a bare "}".
    script = (
        "import sys, json\n"
        f"sys.path.insert(0, {MOVES_DIR!r})\n"
        "try:\n"
        "    import ea_moves as m\n"
        f"    args = json.loads({payload!r})\n"
        f"    result = getattr(m, {func!r})(**args)\n"
        f"    print({MARKER!r} + json.dumps(result, default=str))\n"
        "except Exception as exc:\n"
        f"    print({ERR_MARKER!r} + json.dumps("
        "{'type': type(exc).__name__, 'message': str(exc)}))\n"
    )

    # The CLI has no -c flag; it only accepts a script piped over stdin.
    proc = subprocess.run(
        ["browser-harness"],
        input=script,
        capture_output=True, text=True, timeout=TIMEOUT_S,
    )
    out = proc.stdout or ""

    if MARKER in out:
        return json.loads(out.split(MARKER, 1)[1].splitlines()[0])

    if ERR_MARKER in out:
        info = json.loads(out.split(ERR_MARKER, 1)[1].splitlines()[0])
        detail, kind = info.get("message", ""), info.get("type", "")
        if kind == "EASessionExpired" or "401" in detail or "UNAUTHORIZED" in detail:
            raise ProxyError(
                "EveryAction is not signed in, or the tab the tools are using has "
                "lost its session. Open EveryAction in Chrome, sign in, and try again."
            )
        raise ProxyError(detail or f"{kind} (no message)")

    # No marker at all means the harness itself failed to run the script.
    stderr = (proc.stderr or "").strip()
    raise ProxyError(
        stderr.splitlines()[-1] if stderr else
        f"browser-harness exited {proc.returncode} with no output."
    )


def _guarded(fn):
    """
    Return errors as data instead of raising.

    An exception escaping a tool reaches the model as an opaque "error executing
    tool", which hides messages that name the exact fix. Returned as a value, the
    text survives and the model can act on it.
    """
    @functools.wraps(fn)
    def wrapper(*args: Any, **kwargs: Any):
        try:
            return fn(*args, **kwargs)
        except ProxyError as exc:
            return {"ok": False, "error": str(exc)}
        except Exception as exc:  # noqa: BLE001 - never lose the message
            return {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
    return wrapper


# --------------------------------------------------------------------------
# Read tools
# --------------------------------------------------------------------------

@server.tool()
@_guarded
def check_session() -> dict:
    """Check that Chrome is attached and EveryAction is signed in."""
    from_ = _call("find_contact", query="a", limit=1)
    return {"ok": True, "everyaction": "signed in", "sample_results": len(from_)}


@server.tool()
@_guarded
def find_contact(query: str) -> list[dict]:
    """
    Find EveryAction contacts by name, email, or id.

    Returns each match with both ids: `van_id` for data lookups and `eid` for
    anything that opens a page. Always call this first -- other tools need both.
    """
    return _call("find_contact", query=query)


@server.tool()
@_guarded
def list_plans(contact_eid: str, van_id: int) -> list[dict]:
    """List a contact's moves management action plans with their current stage."""
    plans = _call("list_action_plans", contact_eid=contact_eid, van_id=van_id)
    return [_call("summarize_plan", plan=p) for p in plans] if plans else []


@server.tool()
@_guarded
def list_plan_ids(contact_eid: str) -> list[dict]:
    """
    Get the encoded id (EID) of each of a contact's plans.

    Editing a plan requires this encoded id. The numeric id from list_plans will
    NOT work -- EveryAction silently opens a blank new-plan form instead, and
    saving it creates a duplicate.
    """
    return _call("plan_eids", contact_eid=contact_eid)


@server.tool()
@_guarded
def list_followups(van_id: int) -> list[dict]:
    """List a contact's upcoming scheduled follow-ups."""
    return _call("upcoming_followups", van_id=van_id)


# --------------------------------------------------------------------------
# Write tools -- always preview before applying
# --------------------------------------------------------------------------

@server.tool()
@_guarded
def preview_plan_update(
    contact_eid: str, plan_eid: str, van_id: int,
    status: str | None = None, status_date: str | None = None,
    ask: str | None = None, ask_date: str | None = None,
    projected_amount: str | None = None, projected_date: str | None = None,
    result: str | None = None, committed_amount: str | None = None,
    readiness: int | None = None, likelihood: int | None = None, capacity: int | None = None,
) -> dict:
    """
    Show exactly what would change on an action plan, WITHOUT saving.

    Show this to the person and get their agreement before calling
    apply_plan_update. Dates are YYYY-MM-DD. Status is one of Identification,
    Qualification, Cultivation, Solicitation, Negotiation, Stewardship.
    Readiness, likelihood and capacity are scores from 0 to 999, not words.
    """
    changes = {k: v for k, v in locals().items()
               if k not in ("contact_eid", "plan_eid", "van_id") and v is not None}
    return _call("update_plan", contact_eid=contact_eid, plan_eid=plan_eid,
                 van_id=van_id, dry_run=True, **changes)


@server.tool()
@_guarded
def apply_plan_update(
    contact_eid: str, plan_eid: str, van_id: int,
    status: str | None = None, status_date: str | None = None,
    ask: str | None = None, ask_date: str | None = None,
    projected_amount: str | None = None, projected_date: str | None = None,
    result: str | None = None, committed_amount: str | None = None,
    readiness: int | None = None, likelihood: int | None = None, capacity: int | None = None,
    solicitor: str | None = None,
) -> dict:
    """
    Save changes to an action plan. Run preview_plan_update first and get the
    person's agreement.

    The result reports `verified`, which compares EveryAction's own stored values
    against what was requested -- treat verified=false as a FAILED save and report
    the validation_errors, do not tell the person it worked.

    The plan's existing primary solicitor is kept unless `solicitor` is given.
    """
    changes = {k: v for k, v in locals().items()
               if k not in ("contact_eid", "plan_eid", "van_id", "solicitor") and v is not None}
    return _call("update_plan", contact_eid=contact_eid, plan_eid=plan_eid,
                 van_id=van_id, dry_run=False, solicitor=solicitor, **changes)


@server.tool()
@_guarded
def preview_followup(
    contact_eid: str, van_id: int, date: str,
    how: str = "Phone", priority: str = "Medium",
    notes: str = "", note_category: str | None = None, plan_eid: str | None = None,
) -> dict:
    """
    Show what follow-up would be scheduled, WITHOUT saving, plus the valid
    options for each dropdown in this EveryAction instance.

    `date` is YYYY-MM-DD. Pass `plan_eid` to attach the follow-up to an action plan.
    """
    return _call("schedule_followup", contact_eid=contact_eid, van_id=van_id,
                 date_=date, how=how, priority=priority, notes=notes,
                 note_category=note_category, plan_eid=plan_eid, dry_run=True)


@server.tool()
@_guarded
def schedule_followup(
    contact_eid: str, van_id: int, date: str,
    how: str = "Phone", priority: str = "Medium",
    notes: str = "", note_category: str | None = None, plan_eid: str | None = None,
) -> dict:
    """
    Schedule a follow-up on a contact. Run preview_followup first and get the
    person's agreement.

    Check `verified` in the result before reporting success.
    """
    return _call("schedule_followup", contact_eid=contact_eid, van_id=van_id,
                 date_=date, how=how, priority=priority, notes=notes,
                 note_category=note_category, plan_eid=plan_eid, dry_run=False)


@server.tool()
@_guarded
def list_plan_followups(plan_eid: str) -> list[dict]:
    """
    Follow-ups attached to a specific action plan.

    Use this rather than a plan's `next_due` field to see what is scheduled on a
    plan -- `next_due` stays empty even when follow-ups are correctly attached.
    Also the only source of the follow-up id needed by delete_followup.
    """
    return _call("plan_followups", plan_eid=plan_eid)


@server.tool()
@_guarded
def delete_followup(followup_eid: str, van_id: int) -> dict:
    """
    Permanently delete a scheduled follow-up. Ask the person to confirm first,
    naming the follow-up; this cannot be undone and records no result.

    Get `followup_eid` from list_plan_followups.
    """
    return _call("delete_followup", followup_eid=followup_eid, van_id=van_id)


@server.tool()
@_guarded
def delete_plan(contact_eid: str, plan_eid: str, van_id: int) -> dict:
    """
    Permanently delete an action plan. Ask the person to confirm first, naming
    the plan; this cannot be undone.

    EveryAction refuses to delete a plan that has pledges or follow-ups attached
    and asks you to close it instead -- that comes back as deleted=false.
    """
    return _call("delete_plan", contact_eid=contact_eid, plan_eid=plan_eid, van_id=van_id)


if __name__ == "__main__":
    _self_update()
    server.run()
