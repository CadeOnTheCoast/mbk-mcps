"""
EveryAction internal-API proxy, driven through the user's own browser session.

Why this exists
---------------
EveryAction's Moves Management (action plans + scheduled follow-ups) is served by
real, versioned `/v4` routes on api.securevan.com -- they are simply not granted
to API-key auth. Our key gets 403 on:

    /v4/contactRecords/{id}/actionPlans
    /v4/portfolioManagement/actionPlans/{portfolioId}

The same routes answer fine for a logged-in browser session. So instead of
automating the EveryAction UI (fragile, breaks on every redesign), we execute
`fetch()` *inside an already-authenticated EveryAction tab* and hand back JSON.
Deterministic, selector-free, and it inherits the user's real identity -- which
also keeps EveryAction's audit trail honest.

We never handle credentials. If the session has expired we raise and tell the
user to log in; we do not attempt to authenticate.
"""

from __future__ import annotations

import json
from typing import Any

from browser_harness.helpers import js, list_tabs, switch_tab, new_tab, wait_for_load, page_info

# Where to open a tab when none exists. The app root lands on the signed-in
# homepage and carries the session cookies the /v4 routes need; a bare
# Contact.aspx with no record id is an error page.
#
# EveryAction shards across numbered hosts and the org determines which. This is
# only a cold-start fallback -- whenever a real EveryAction tab is already open,
# origin() reads the shard from it rather than assuming this one.
_FALLBACK_URL = "https://app5.everyaction.com/"
_EA_HOST_SUFFIX = "everyaction.com"
# EveryAction signs in through Bonterra's identity provider; landing here
# means the session lapsed, not that the browser is broken.
_AUTH_HOSTS = ("auth.bonterra.network", "bonterra.network/u/login")


class EASessionError(RuntimeError):
    """Raised when EveryAction is not reachable in a logged-in browser tab."""


class EASessionExpired(EASessionError):
    """The tab exists but EveryAction bounced us to login."""


# The one tab this proxy drives, remembered for the life of the process.
#
# Rescanning for "the first everyaction.com tab" on every call is a trap: a user
# with several EveryAction tabs open gets a different one each time, so a
# sequence like navigate-to-plan -> read-API -> touch-the-form silently splits
# across two tabs and the form work executes against a page that never had the
# form on it. Pick a tab once, keep it, and only re-pick if it disappears.
_PINNED: str | None = None


def _live_targets() -> dict[str, str]:
    return {t["targetId"]: (t.get("url") or "") for t in list_tabs()}


def _ea_target() -> str:
    """Return the targetId of this proxy's EveryAction tab, opening one if needed."""
    global _PINNED

    targets = _live_targets()
    if _PINNED and _EA_HOST_SUFFIX in targets.get(_PINNED, ""):
        return _PINNED

    for target_id, url in targets.items():
        if _EA_HOST_SUFFIX in url:
            _PINNED = target_id
            return _PINNED

    new_tab(_FALLBACK_URL)
    wait_for_load()
    targets = _live_targets()
    for target_id, url in targets.items():
        if _EA_HOST_SUFFIX in url:
            _PINNED = target_id
            return _PINNED

    # Opening EveryAction and landing on the identity provider means the session
    # has expired -- Chrome is fine. Say that, because "is Chrome running?" sends
    # people to debug the wrong thing entirely.
    if any(host in url for url in targets.values() for host in _AUTH_HOSTS):
        raise EASessionExpired(
            "You are signed out of EveryAction. Sign in to EveryAction in Chrome, "
            "then try again. (This tool never enters credentials for you.)"
        )

    raise EASessionError(
        "Could not open an EveryAction tab. Is Chrome running and attached to the harness? "
        "Try: browser-harness --setup"
    )


def use_tab(target_id: str) -> str:
    """Pin the proxy to a specific tab (useful when several are open)."""
    global _PINNED
    if _EA_HOST_SUFFIX not in _live_targets().get(target_id, ""):
        raise EASessionError(f"{target_id} is not an EveryAction tab.")
    _PINNED = target_id
    return _PINNED


def origin() -> str:
    """
    The EveryAction origin currently in use, e.g. https://app5.everyaction.com.

    EveryAction shards its app across numbered hosts (app5, app6, ...) and the
    generic app.everyaction.com 404s on these routes, so the shard is read from
    the live tab rather than hardcoded.
    """
    switch_tab(_ea_target())
    url = page_info()["url"]
    scheme, _, rest = url.partition("://")
    return f"{scheme}://{rest.split('/')[0]}"


def ea_api(method: str, path: str, body: Any | None = None, timeout_s: int = 30) -> Any:
    """
    Call an EveryAction /v4 endpoint from inside the authenticated tab.

    `path` is origin-relative and must start with /v4/. Returns parsed JSON for
    2xx responses. Raises EASessionExpired if EveryAction served a login page
    (detected by an HTML content-type, which these JSON routes never return).
    """
    if not path.startswith("/v4/"):
        raise ValueError(f"path must start with /v4/ -- got {path!r}")

    switch_tab(_ea_target())

    payload = json.dumps(
        {"method": method.upper(), "path": path, "body": body, "timeoutMs": timeout_s * 1000}
    )

    script = """
    (async (spec) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), spec.timeoutMs);
      try {
        const init = {
          method: spec.method,
          headers: {"Accept": "application/json"},
          credentials: "same-origin",
          signal: ctl.signal,
        };
        if (spec.body !== null && spec.body !== undefined) {
          init.headers["Content-Type"] = "application/json";
          init.body = JSON.stringify(spec.body);
        }
        const r = await fetch(spec.path, init);
        const ct = r.headers.get("content-type") || "";
        const text = await r.text();
        return JSON.stringify({status: r.status, contentType: ct, body: text.slice(0, 200000)});
      } catch (e) {
        return JSON.stringify({status: 0, contentType: "", body: "", error: String(e)});
      } finally {
        clearTimeout(timer);
      }
    })(__SPEC__)
    """.replace("__SPEC__", payload)

    raw = js(script)
    if raw is None:
        raise EASessionError(f"No response evaluating {method} {path} in the EveryAction tab.")

    result = json.loads(raw) if isinstance(raw, str) else raw

    if result.get("error"):
        raise EASessionError(f"{method} {path} failed in-page: {result['error']}")

    status, ctype, text = result["status"], result.get("contentType", ""), result.get("body", "")

    # These routes always answer JSON, so HTML means something intercepted us.
    # Distinguish the two cases: an auth bounce is a 2xx/3xx login page, while a
    # 4xx/5xx HTML body is just EveryAction's error page for a route that does
    # not exist. Reporting the latter as "session expired" sends people off to
    # re-authenticate over what is really a typo in a path.
    if "text/html" in ctype:
        if status >= 400:
            raise EASessionError(
                f"{method} {path} -> HTTP {status} (EveryAction served an HTML error "
                f"page, so this route probably does not exist)."
            )
        raise EASessionExpired(
            "EveryAction returned a login page. Open EveryAction in Chrome, sign in, "
            "and try again. (This tool never enters credentials for you.)"
        )

    if status >= 400:
        raise EASessionError(f"{method} {path} -> HTTP {status}: {text[:400]}")

    if not text.strip():
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError as exc:
        raise EASessionError(f"{method} {path} returned non-JSON: {text[:200]}") from exc


def check() -> dict:
    """Cheap health probe: confirms an EveryAction tab exists and the session is live."""
    org = origin()
    probe = ea_api("GET", "/v4/contactViewConfigurations/primary")
    return {
        "origin": org,
        "session": "live",
        "probe": list(probe)[:8] if isinstance(probe, dict) else type(probe).__name__,
    }
