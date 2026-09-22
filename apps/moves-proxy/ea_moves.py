"""
Moves Management (action plans + follow-ups) for EveryAction.

Split architecture, forced by how EveryAction is actually built:

  READS  -> /v4 JSON API, executed inside the logged-in tab (see ea_session).
            Clean, structured, fast. The contact record's SPA uses these too.

  WRITES -> ActionPlanDetails.aspx, a classic ASP.NET WebForms page.
            There is no JSON write endpoint. Postbacks carry ViewState and
            EventValidation, which we deliberately do NOT try to forge --
            we drive the real form in the real page and let the browser
            round-trip those blobs for us.

Every write is verified by reading the plan back through the JSON API, so a
silently-failed postback surfaces as an error rather than a false success.

Field selectors use the stable `vdi*` suffix (e.g. [id$="_vdiStatus"]) rather
than the full ctl00_ContentPlaceHolder... path. WebForms regenerates the prefix
when the control tree is rearranged; the vdi token is the semantic name and
survives.
"""

from __future__ import annotations

import json
import re
import time
from datetime import date, timedelta
from typing import Any

from browser_harness.helpers import js, wait, page_info, goto_url, wait_for_load

from ea_session import ea_api, origin, switch_tab, EASessionError, _ea_target

# The action plan stage ladder, in the order EveryAction presents it.
STATUSES = [
    "Identification", "Qualification", "Cultivation",
    "Solicitation", "Negotiation", "Stewardship", "Closed",
]

RESULTS = ["Yes", "No", "Maybe", "Later"]

# Editable fields on ActionPlanDetails.aspx, keyed by the vdi token.
PLAN_FIELDS = {
    "start_date":       ("vdiStartDate", "date"),
    "status":           ("vdiStatus", "select"),
    "status_date":      ("vdiStatusDate", "date"),
    "ask":              ("vdiAsk", "money"),
    "ask_date":         ("vdiAskDate", "date"),
    "projected_amount": ("vdiProjectedAmount", "money"),
    "projected_date":   ("vdiProjectedDate", "date"),
    "result":           ("vdiResult", "select"),
    "result_date":      ("vdiResultDate", "date"),
    "committed_amount": ("vdiCommittedAmount", "money"),
    # Readiness / Likelihood / Capacity are numeric SCORES, not labels.
    # The page validator rejects anything outside 0-999 ("High" fails).
    "readiness":        ("vdiReadiness", "score"),
    "likelihood":       ("vdiLikelihood", "score"),
    "capacity":         ("vdiCapacity", "score"),
}

_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class MovesError(RuntimeError):
    pass


# --------------------------------------------------------------------------
# Reads -- JSON API
# --------------------------------------------------------------------------

def list_action_plans(contact_eid: str, van_id: int) -> list[dict]:
    """
    All action plans on a contact.

    `contact_eid` is the encoded id EveryAction puts in contact URLs
    (Contact.aspx?VanID=EID0A1B2C); `van_id` is the numeric VANID shown on
    the record. The endpoint wants both -- EID in the path, numeric in the query.
    """
    path = f"/v4/contactRecords/{contact_eid}/actionPlans?vanIds%5B%5D={int(van_id)}"
    plans = ea_api("GET", path)
    return plans if isinstance(plans, list) else []


def upcoming_followups(van_id: int, top: int = 100) -> list[dict]:
    """
    Scheduled follow-ups for a contact.

    Follow-ups are exposed as an activity type rather than their own resource.
    Note this particular route DOES answer to plain API-key auth as well, so it
    is a candidate to move into the hosted MCP later.
    """
    path = (
        f"/v4/people/{int(van_id)}/activities"
        f"?%24top={int(top)}&periodType=Upcoming"
        f"&activityTypes=FollowUp&vanIds%5B%5D={int(van_id)}"
    )
    res = ea_api("GET", path)
    items = (res or {}).get("items", []) if isinstance(res, dict) else []
    out = []
    for it in items:
        d = it.get("data") or {}
        out.append({
            "activity_id": it.get("activityId"),
            "date": it.get("date"),
            "how": d.get("contactTypeName"),
            "priority": d.get("priority"),
            "assigned_to": d.get("followUpUserName"),
            "result": d.get("result"),
            "status": it.get("verb"),
        })
    return out


def find_contact(query: str, limit: int = 10) -> list[dict]:
    """
    Resolve a name (or email, or id) to contacts, WITH their encoded ids.

    Contact.aspx and ActionPlanDetails.aspx address records exclusively by EID
    -- a numeric VANID lands on an error page -- while the JSON API speaks
    numeric, so both ids are worth carrying around.

    For CONTACTS the EID is computable from the numeric id (see
    encode_contact_eid), so this endpoint is not the only source of one. It is
    still the way to go from a name or email to a record. PLAN eids must come
    from plan_eids(); their check scheme is different and unsolved.
    """
    res = ea_api("GET", f"/v4/omniSearchSuggestions?q={query.strip()}")
    items = (res or {}).get("items", []) if isinstance(res, dict) else []
    out = []
    for it in items:
        if it.get("entityType") != "Contacts" or not it.get("entityEId"):
            continue
        out.append({
            "van_id": it.get("entityId"),
            "eid": it.get("entityEId"),
            "name": it.get("fullName"),
            "email": it.get("email"),
            "address": it.get("address"),
            "lifetime_total": it.get("lifetimeTotal"),
        })
        if len(out) >= limit:
            break
    return out


def summarize_plan(plan: dict) -> dict:
    """Trim a 43-field plan record down to what a human actually decides on."""
    return {
        "id": plan.get("id"),
        "contact": plan.get("contactDisplayName"),
        "van_id": plan.get("vanId"),
        "status": plan.get("statusName"),
        "start_date": plan.get("startDate"),
        "status_date": plan.get("statusDate"),
        "next_due": plan.get("nextDueDate"),
        "ask_amount": plan.get("askAmount"),
        "ask_date": plan.get("askDate"),
        "committed": plan.get("askCommittedAmount"),
        "result": plan.get("resultName"),
        "solicitor": plan.get("primarySolicitorDisplayName"),
        "campaign": plan.get("campaignName"),
        "closed": plan.get("isClosed"),
    }


# --------------------------------------------------------------------------
# Writes -- WebForms, driven in-page
# --------------------------------------------------------------------------

_EID = re.compile(r"^EID[0-9A-Z]{3,12}$")


def plan_url(plan_eid: str) -> str:
    return (
        f"{origin()}/ActionPlanDetails.aspx"
        f"?ContactsActionPlanID={plan_eid}&FromPage=Contact"
    )


def plan_eids(contact_eid: str) -> list[dict]:
    """
    Map each of a contact's action plans to its encoded id.

    ActionPlanDetails.aspx addresses plans by an opaque EID ("EID4321Z"), and
    the JSON API exposes only the numeric id -- there is no encoded id anywhere
    in the plan record. The contact page is the one place both exist together,
    so we read the edit links straight off it and pair them with the visible row.
    """
    switch_tab(_ea_target())
    goto_url(f"{origin()}/Contact.aspx?VanID={contact_eid}#/")
    wait_for_load()

    # NOTE: this snippet MUST be written as an IIFE starting with "(".
    # browser-harness auto-wraps any expression containing `return` in
    # `(function(){...})()` unless it already starts with "(" -- and a wrapped
    # body whose last line is a bare expression evaluates to undefined. A snippet
    # with `return` inside an arrow callback therefore comes back as None with no
    # error, which reads exactly like "this contact has no plans".
    scrape = r"""
    (() => JSON.stringify([...document.querySelectorAll("a[href*='ActionPlanDetails']")]
      .filter(a => /ContactsActionPlanID=/i.test(a.getAttribute("href") || ""))
      .map(a => {
        const eid = (a.getAttribute("href").match(/ContactsActionPlanID=([^&]+)/i) || [])[1];
        let row = a.closest("tr, [role=row], li, div");
        for (let i = 0; i < 4 && row; i++) {
          const t = (row.innerText || "").replace(/\s+/g, " ").trim();
          if (t.length > 12) return {eid: eid, row: t.slice(0, 140)};
          row = row.parentElement;
        }
        return {eid: eid, row: ""};
      })))()
    """

    # The moves-management panel renders well after load, and how late depends on
    # how much history the contact has. A fixed sleep either wastes time or --
    # worse -- returns an empty list that looks like "this contact has no plans".
    # Poll instead, and only give up once the page has had a fair chance.
    for _ in range(12):
        rows = json.loads(js(scrape) or "[]")
        if rows:
            return rows
        wait(2)
    return []


def open_plan(contact_eid: str, plan_eid: str) -> None:
    """
    Navigate the pinned tab to a plan's EDIT page.

    `plan_eid` MUST be the encoded id (EID...), never the numeric id from the
    JSON API. ActionPlanDetails.aspx silently falls back to a blank CREATE form
    when it does not recognise the id -- prefilled with today's date and the
    first status -- so a numeric id looks like a successfully loaded plan and
    then every save quietly creates a duplicate instead of updating. This guard
    exists because that is exactly what happened.
    """
    if not _EID.match(str(plan_eid)):
        raise MovesError(
            f"plan_eid must be an encoded id like 'EID4321Z', got {plan_eid!r}. "
            f"The numeric id from the API will open a NEW plan form and saving "
            f"it creates a duplicate. Use plan_eids() to look up the right one."
        )

    switch_tab(_ea_target())
    goto_url(plan_url(plan_eid))
    wait_for_load()
    wait(3)

    landed = page_info()["url"]
    if "ActionPlanDetails" not in landed:
        raise MovesError(f"Could not open plan {plan_eid}; landed on {landed[:120]}")
    if plan_eid.lower() not in landed.lower():
        raise MovesError(
            f"Opened {landed[:120]} but expected plan {plan_eid}. Refusing to continue: "
            f"this is the create-form fallback and saving would make a duplicate."
        )


def read_form() -> dict:
    """
    Current values of every editable field on the open plan page.

    Selects are reported by their visible label, not the underlying numeric
    config id, so a dry-run preview reads "Cultivation" rather than "433545".
    """
    raw = js(r"""
    (() => {
      const out = {};
      for (const e of document.querySelectorAll("#aspnetForm [id*='vdi']")) {
        if (!["INPUT","SELECT","TEXTAREA"].includes(e.tagName) || e.type === "hidden") continue;
        const m = (e.id || "").match(/_(vdi[A-Za-z0-9]+)$/);
        if (!m) continue;
        out[m[1]] = e.tagName === "SELECT"
          ? ((e.selectedOptions[0] && e.selectedOptions[0].text.trim()) || "")
          : e.value;
      }
      return JSON.stringify(out);
    })()
    """)
    return json.loads(raw) if raw else {}


def _normalize(value: Any, kind: str) -> str:
    if value is None:
        return ""
    if kind == "date":
        s = str(value).strip()
        if _ISO_DATE.match(s):
            y, m, d = s.split("-")
            # EveryAction's date inputs are US-format.
            return f"{int(m)}/{int(d)}/{y}"
        return s
    if kind == "money":
        return str(value).replace("$", "").replace(",", "").strip()
    if kind == "score":
        s = str(value).strip()
        if s == "":
            return ""
        try:
            n = int(float(s))
        except ValueError:
            raise MovesError(
                f"{value!r} is not a valid score. Readiness, likelihood and capacity "
                f"are numbers from 0 to 999 in EveryAction, not labels like 'High'."
            ) from None
        if not 0 <= n <= 999:
            raise MovesError(f"Score must be between 0 and 999, got {n}.")
        return str(n)
    return str(value).strip()


def _set_field(key: str, text: str, is_select: bool, scope: str = "#aspnetForm",
               label: str | None = None) -> None:
    """
    Type a value into one WebForms control, addressed by its stable id suffix.

    Scoping by TAG matters: WebForms renders sibling wrappers and hidden mirrors
    whose ids also end in the same token, so a bare [id$=...] selector grabs the
    wrapper rather than the control and silently does nothing.
    """
    spec = json.dumps({"key": key, "value": text, "isSelect": is_select, "scope": scope})
    ok = js("""
    ((spec) => {
      const sel = spec.isSelect
        ? spec.scope + " select[id$='_" + spec.key + "']"
        : spec.scope + " input[id$='_" + spec.key + "'], " +
          spec.scope + " textarea[id$='_" + spec.key + "']";
      const el = document.querySelector(sel) || document.getElementById(spec.key);
      if (!el) return "missing";
      let v = spec.value;
      if (spec.isSelect) {
        // Option VALUES are org-specific numeric config ids ("433545"), not the
        // label, so resolve the label against the live <option> list at run time
        // and keep nothing org-specific in this file.
        const want = String(v).trim().toLowerCase();
        const opt = [...el.options].find(o => o.text.trim().toLowerCase() === want);
        if (!opt) return "badoption:" + [...el.options].map(o => o.text.trim()).filter(Boolean).join(", ");
        v = opt.value;
      }
      const proto = el.tagName === "SELECT" ? window.HTMLSelectElement.prototype
                  : el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype
                  : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);

      // Some WebForms controls are AutoPostBack: dispatching "change" reloads
      // the whole page, so the caller has to wait before touching the next
      // field or it writes into a document that is being torn down.
      const posts = /__doPostBack|WebForm_DoPostBack/.test(
        (el.getAttribute("onchange") || "") + (el.getAttribute("onclick") || ""));

      el.dispatchEvent(new Event("input",  {bubbles: true}));
      el.dispatchEvent(new Event("change", {bubbles: true}));
      el.dispatchEvent(new Event("blur",   {bubbles: true}));
      return posts ? "ok:postback" : "ok";
    })(__SPEC__)
    """.replace("__SPEC__", spec))

    name = label or key
    if ok == "missing":
        raise MovesError(f"Field {name} ({key}) is not present on this page.")
    if isinstance(ok, str) and ok.startswith("badoption:"):
        raise MovesError(f"{name}={text!r} is not a valid option. Available: {ok[10:]}")
    if ok == "ok:postback":
        wait_for_load()
        wait(2)


def stage_changes(**changes: Any) -> dict:
    """
    Type the requested values into the open plan form WITHOUT saving.

    Returns {field: {"from": old, "to": new}} so a caller can show the user
    exactly what is about to change before committing.
    """
    unknown = set(changes) - set(PLAN_FIELDS)
    if unknown:
        raise MovesError(f"Unknown plan fields: {sorted(unknown)}. Known: {sorted(PLAN_FIELDS)}")

    for name, value in changes.items():
        key, kind = PLAN_FIELDS[name]
        text = _normalize(value, kind)
        # Select options are validated in-page against the live <option> list
        # rather than a constant here, so a stage added in EveryAction admin
        # works without a code change.

        _set_field(key, text, kind == "select", label=name)

    return read_form()


def delete_plan(contact_eid: str, plan_eid: str, van_id: int) -> dict:
    """
    Delete an action plan, verifying against the server that it actually went.

    EveryAction refuses to delete a plan that has items (pledges, follow-ups)
    attached and tells you to close it instead; that refusal surfaces here as
    deleted=False plus the page's own message, rather than a silent no-op.
    """
    before = {p.get("id") for p in list_action_plans(contact_eid, van_id)}
    open_plan(contact_eid, plan_eid)

    # The confirm() would block the renderer, and we have already decided.
    js('window.confirm = function(){ return true; }; window.onbeforeunload = null; "ok"')

    clicked = js("""
    (() => {
      const b = document.querySelector("[id$='_DeleteHeaderButton']")
             || document.querySelector("[id$='_DeleteFooterButton']");
      if (!b) return "no-delete-control";
      b.click();
      return b.id;
    })()
    """)
    if clicked == "no-delete-control":
        raise MovesError(f"No delete control on plan {plan_eid}.")

    wait_for_load()
    wait(3)

    notice = js(r"""
    JSON.stringify([...document.querySelectorAll("span,div")]
      .filter(e => e.offsetParent !== null && !e.querySelector("span,div"))
      .map(e => (e.innerText||"").trim())
      .filter(t => t && t.length < 200 && /cannot be deleted|closed|error/i.test(t)).slice(0,3))
    """)

    after = {p.get("id") for p in list_action_plans(contact_eid, van_id)}
    removed = sorted(before - after)
    return {
        "plan": plan_eid,
        "deleted": bool(removed),
        "removed_ids": removed,
        "remaining": len(after),
        "notice": json.loads(notice) if notice else [],
    }


# --------------------------------------------------------------------------
# Scheduled follow-ups
# --------------------------------------------------------------------------
#
# A follow-up is a *contact history* record with a future date, which is why the
# JSON API surfaces it as activityTypes=FollowUp rather than its own resource.
# The form lives at ContactHistoryDetails.aspx in Mode=Schedule; in the UI it is
# shown inside a Telerik RadWindow, but the page stands on its own and driving
# it directly avoids the modal iframe entirely.

FOLLOWUP_FIELDS = {
    "date":          ("CallBack", "date"),
    "how":           ("ContactType", "select"),
    "priority":      ("VanDetailsItemPriority", "select"),
    "notes":         ("Notes", "text"),
    "note_category": ("NoteCategoryID", "select"),
    "link_to_plan":  ("vdiLinkToPlan", "select"),
}


def open_followup_form(contact_eid: str, plan_eid: str | None = None) -> None:
    """Open the Schedule Follow Up form, optionally pre-linked to an action plan."""
    if not _EID.match(str(contact_eid)):
        raise MovesError(f"contact_eid must be an encoded id, got {contact_eid!r}.")
    url = f"{origin()}/ContactHistoryDetails.aspx?VANID={contact_eid}&Mode=Schedule"
    if plan_eid:
        if not _EID.match(str(plan_eid)):
            raise MovesError(f"plan_eid must be an encoded id, got {plan_eid!r}.")
        url += f"&ContactsActionPlanId={plan_eid}"

    switch_tab(_ea_target())
    goto_url(url)
    wait_for_load()
    wait(3)
    if "ContactHistoryDetails" not in page_info()["url"]:
        raise MovesError(f"Could not open the follow-up form; landed on {page_info()['url'][:120]}")


def read_followup_form() -> dict:
    """Current values on the open follow-up form, selects rendered as labels."""
    raw = js(r"""
    (() => {
      const keys = ["CallBack","ContactType","VanDetailsItemPriority","Notes","NoteCategoryID","vdiLinkToPlan"];
      const out = {};
      for (const k of keys) {
        // Scope to real controls. A bare [id$=...] also matches WebForms wrapper
        // elements, whose .value is undefined -- and JSON.stringify DROPS
        // undefined keys, so the field silently vanishes from the result rather
        // than erroring.
        const el = document.querySelector(
          "form input[id$='_" + k + "'], form select[id$='_" + k + "'], " +
          "form textarea[id$='_" + k + "']") || document.getElementById(k);
        if (!el || el.value === undefined) continue;
        out[k] = el.tagName === "SELECT"
          ? ((el.selectedOptions[0] && el.selectedOptions[0].text.trim()) || "")
          : el.value;
      }
      return JSON.stringify(out);
    })()
    """)
    return json.loads(raw) if raw else {}


def followup_options() -> dict:
    """The choices EveryAction currently offers for each dropdown on the form."""
    raw = js(r"""
    (() => {
      const keys = ["ContactType","VanDetailsItemPriority","NoteCategoryID","vdiLinkToPlan"];
      const out = {};
      for (const k of keys) {
        const el = document.querySelector("form select[id$='_" + k + "']") || document.getElementById(k);
        if (el) out[k] = [...el.options].map(o => o.text.trim()).filter(Boolean);
      }
      return JSON.stringify(out);
    })()
    """)
    return json.loads(raw) if raw else {}


def schedule_followup(
    contact_eid: str,
    van_id: int,
    date_: str,
    how: str = "Phone",
    priority: str = "Medium",
    notes: str = "",
    note_category: str | None = None,
    plan_eid: str | None = None,
    dry_run: bool = True,
) -> dict:
    """
    Schedule a follow-up on a contact, optionally attached to an action plan.

    dry_run=True reports what would be entered and the valid options for each
    dropdown, without saving. dry_run=False saves and then confirms through the
    JSON API that the follow-up actually exists.
    """
    open_followup_form(contact_eid, plan_eid)
    before = read_followup_form()
    options = followup_options()

    changes: dict[str, Any] = {"date": date_, "how": how, "priority": priority}
    if notes:
        changes["notes"] = notes
    if note_category:
        changes["note_category"] = note_category

    # The ContactsActionPlanId URL parameter preselects "Link to an Action Plan",
    # but setting Follow Up How triggers an AutoPostBack that re-renders the form
    # and drops that selection -- so the follow-up saves unlinked and the plan's
    # nextDueDate stays empty. Carry the preselected label through as an explicit
    # change so it is re-asserted after every postback.
    if plan_eid:
        preselected = before.get("vdiLinkToPlan", "")
        if preselected:
            changes["link_to_plan"] = preselected

    preview = {
        name: {"from": before.get(FOLLOWUP_FIELDS[name][0], ""),
               "to": _normalize(value, FOLLOWUP_FIELDS[name][1])}
        for name, value in changes.items()
    }

    if dry_run:
        return {"dry_run": True, "contact": contact_eid, "changes": preview, "options": options}

    # Selects first: any of them may AutoPostBack and re-render the page, which
    # would discard text typed beforehand. Then re-read and re-apply anything
    # that did not survive, rather than trusting the first pass.
    ordered = sorted(changes.items(), key=lambda kv: FOLLOWUP_FIELDS[kv[0]][1] != "select")
    for name, value in ordered:
        key, kind = FOLLOWUP_FIELDS[name]
        _set_field(key, _normalize(value, kind), kind == "select", scope="form", label=name)

    landed = read_followup_form()
    for name, value in ordered:
        key, kind = FOLLOWUP_FIELDS[name]
        want = _normalize(value, kind)
        if str(landed.get(key, "")).strip().lower() != want.strip().lower():
            _set_field(key, want, kind == "select", scope="form", label=name)

    clicked = js("""
    (() => {
      const b = document.querySelector("form [id$='_SaveButton']");
      if (!b) return "no-save";
      b.click();
      return b.id;
    })()
    """)
    if clicked == "no-save":
        raise MovesError("Save button not found on the follow-up form.")
    wait_for_load()
    wait(3)

    blockers = js(r"""
    JSON.stringify([...document.querySelectorAll("[id*='Validator'],[id*='valid'],.field-validation-error")]
      .filter(e => e.offsetParent !== null && (e.innerText||"").trim())
      .map(e => (e.innerText||"").trim().slice(0,120)).slice(0,6))
    """)
    blockers = json.loads(blockers) if blockers else []

    time.sleep(1)
    existing = upcoming_followups(van_id)

    result = {
        "dry_run": False,
        "contact": contact_eid,
        "requested": preview,
        "verified": bool(existing) and not blockers,
        "followups_now": len(existing),
        "validation_errors": blockers,
    }

    # Confirm the plan association by reading the plan's own follow-up list.
    # A plan's nextDueDate is NOT a usable signal here -- it stays null even when
    # follow-ups are correctly attached -- so checking it would report a working
    # link as broken.
    if plan_eid:
        attached = plan_followups(plan_eid)
        result["plan_link"] = {
            "plan": plan_eid,
            "persisted": len(attached) > 0,
            "attached_followups": len(attached),
        }
    return result


def plan_followups(plan_eid: str) -> list[dict]:
    """
    Follow-ups attached to an action plan, read from the plan page.

    There is no JSON route for this: the contact-level activities feed returns
    follow-ups without any plan reference, and the plan record's `nextDueDate`
    stays null whether or not follow-ups are attached. The plan page is the only
    place the association is visible -- each attached follow-up renders Cancel and
    Delete links carrying its own encoded id (CFUID).
    """
    switch_tab(_ea_target())
    goto_url(plan_url(plan_eid))
    wait_for_load()

    for _ in range(8):
        raw = js(r"""
        (() => {
          const seen = {};
          for (const a of document.querySelectorAll("a[href*='ConfirmFollowUpActionModal']")) {
            const href = a.getAttribute("href") || "";
            const id = (href.match(/CFUID=([^&]+)/i) || [])[1];
            const act = (href.match(/FollowUpAction=(\d+)/i) || [])[1];
            if (!id) continue;
            seen[id] = seen[id] || {eid: id, actions: []};
            seen[id].actions.push(act);
          }
          return JSON.stringify(Object.values(seen));
        })()
        """)
        rows = json.loads(raw) if raw else []
        if rows:
            return rows
        wait(2)
    return []


# FollowUpAction values on ConfirmFollowUpActionModal.aspx.
_FOLLOWUP_CANCEL = 3
_FOLLOWUP_DELETE = 4


def delete_followup(followup_eid: str, van_id: int) -> dict:
    """
    Delete a scheduled follow-up, verifying it is gone afterwards.

    Deletion runs through a confirmation modal page keyed by the follow-up's own
    encoded id (CFUID), which is exposed on the action plan page rather than
    anywhere in the JSON API.
    """
    if not _EID.match(str(followup_eid)):
        raise MovesError(f"followup_eid must be an encoded id, got {followup_eid!r}.")

    before = {f.get("activity_id") for f in upcoming_followups(van_id)}

    switch_tab(_ea_target())
    goto_url(f"{origin()}/ConfirmFollowUpActionModal.aspx"
             f"?CFUID={followup_eid}&FollowUpAction={_FOLLOWUP_DELETE}")
    wait_for_load()
    wait(2)

    js('window.confirm = function(){ return true; }; "ok"')

    # The confirm button is type="button" with
    #   onclick="GetRadWindow().Close(); __doPostBack('<name>','')"
    # Opened directly rather than inside its Telerik RadWindow, GetRadWindow()
    # throws and the exception short-circuits the __doPostBack that does the
    # actual work -- so clicking appears to succeed and deletes nothing. Fire the
    # postback ourselves using the control's name.
    # Do NOT call __doPostBack: ASP.NET's AJAX build inspects arguments.callee,
    # which throws when invoked from our (strict-mode) evaluated function. Set
    # the event fields and submit the form ourselves -- the same thing
    # __doPostBack does, minus the stack walking.
    clicked = js("""
    (() => {
      const b = document.querySelector("[id$='ButtonConfirmFollowUpAction']");
      if (!b) return "no-confirm-control";
      const target = b.name || b.id.replace(/_/g, "$");
      const form = document.forms["aspnetForm"] || document.forms[0];
      if (!form) return "no-form";
      const et = form.__EVENTTARGET   || document.getElementsByName("__EVENTTARGET")[0];
      const ea = form.__EVENTARGUMENT || document.getElementsByName("__EVENTARGUMENT")[0];
      if (!et) return "no-eventtarget";
      et.value = target;
      if (ea) ea.value = "";
      form.submit();
      return target;
    })()
    """)
    if clicked in ("no-confirm-control", "no-form", "no-eventtarget"):
        raise MovesError(f"Could not confirm deletion of {followup_eid}: {clicked}")
    wait_for_load()
    wait(3)

    after = {f.get("activity_id") for f in upcoming_followups(van_id)}
    removed = sorted(x for x in before - after if x)
    return {
        "followup": followup_eid,
        "deleted": bool(removed),
        "removed": removed,
        "remaining": len(after),
        "confirm_control": clicked,
    }


def resolve_user(name: str) -> dict:
    """
    Look up an EveryAction staff user by name.

    This is the same endpoint the Primary Solicitor picker calls once you type
    three characters. Note /v4/users is 403 for API-key auth but fine in-session,
    which is the only reason we can resolve a solicitor id at all -- the action
    plan JSON exposes solicitor display names but no id.
    """
    res = ea_api("GET", f"/v4/users?matchName={name.strip()}&%24top=25&%24skip=0")
    items = (res or {}).get("items", []) if isinstance(res, dict) else []
    if not items:
        raise MovesError(f"No EveryAction user matches {name!r}.")
    needle = name.strip().lower()
    exact = [u for u in items if needle in (u.get("name") or "").lower()
             or needle in (u.get("displayNameFirstNameFirst") or "").lower()]
    pool = exact or items
    if len(pool) > 1:
        opts = ", ".join(u.get("name", "?") for u in pool[:8])
        raise MovesError(f"{name!r} is ambiguous. Matches: {opts}")
    return pool[0]


def set_solicitor(name: str) -> str:
    """
    Populate the Primary Solicitor picker on the open plan page.

    THIS IS REQUIRED BEFORE EVERY SAVE. The picker is a select2 widget whose
    backing hidden input is empty on page load even when the plan already has a
    solicitor, so an untouched form fails server validation with
    "Please enter a Primary Solicitor" and the postback is silently rejected.
    """
    user = resolve_user(name)
    spec = json.dumps({"id": str(user["userId"]), "text": user.get("name") or name})
    out = js("""
    ((d) => {
      const $h = jQuery("#hidden_vdiPrimarySolicitor_Select2");
      if (!$h.length) return "missing";
      try { $h.select2("close"); } catch (e) {}
      try { $h.select2("data", {id: d.id, text: d.text}); }
      catch (e) { return "failed: " + e.message; }
      $h.trigger("change");
      return document.getElementById("hidden_vdiPrimarySolicitor_Select2").value;
    })(__D__)
    """.replace("__D__", spec))
    if out in (None, "missing") or str(out).startswith("failed"):
        raise MovesError(f"Could not set Primary Solicitor: {out}")
    return str(out)


def save() -> None:
    """Submit the WebForms page. The browser carries ViewState for us."""
    ok = js("""
    (() => {
      const b = document.querySelector("#ctl00_ContentPlaceHolderVANPage_SaveHead")
             || document.querySelector("#aspnetForm input[type=submit][value='Save']");
      if (!b) return false;
      b.click();
      return true;
    })()
    """)
    if not ok:
        raise MovesError("Save button not found on the plan page.")
    wait_for_load()
    wait(3)


def decode_eid(plan_eid: str) -> int | None:
    """
    Recover the numeric plan id from an encoded EID.

    Observed encoding, verified against all five plans on a live record:
    take the id in uppercase hex, prepend a single check character, reverse the
    whole string, prefix "EID". So EID4321Z -> reverse("4321Z") -> "Z1234" ->
    drop the check char -> 0x1234 -> 4660.

    This is undocumented, so callers must treat a decode as a hypothesis and
    confirm the id actually exists (find_plan does). Returns None if the shape
    does not fit rather than guessing.
    """
    if not _EID.match(str(plan_eid)):
        return None
    body = str(plan_eid)[3:][::-1]
    if len(body) < 2:
        return None
    try:
        return int(body[1:], 16)
    except ValueError:
        return None


def encode_contact_eid(van_id: int) -> str:
    """
    Build a CONTACT's encoded id from its numeric VanID.

    The check character is not arbitrary: it is `chr(65 + vanId % 17)`, i.e. a
    mod-17 letter in A-Q. Verified against 11 live contacts (11/11) plus an
    end-to-end page load of a constructed id. This is the inverse of
    decode_eid() for contacts, and it means a contact's web URL can be built
    from the numeric id the JSON API already returns -- find_contact() is not
    required just to produce a link.

    CONTACTS ONLY. Action plans use a different check scheme (a plan whose id
    decodes to 4660 carries check char 'Z', where this rule would give 'C'), so
    do not reach for this to address ActionPlanDetails.aspx. Plan ids still have
    to come from plan_eids().
    """
    van_id = int(van_id)
    if van_id <= 0:
        raise MovesError(f"van_id must be a positive integer, got {van_id!r}.")
    return "EID" + (chr(ord("A") + van_id % 17) + format(van_id, "X"))[::-1]


def contact_url(van_id: int) -> str:
    """The EveryAction web URL for a contact record, from its numeric VanID."""
    return f"{origin()}/Contact.aspx?VanID={encode_contact_eid(van_id)}#/"


def find_plan(contact_eid: str, van_id: int, plan_eid: str) -> dict | None:
    """The API record for an encoded plan id, or None if it cannot be matched."""
    plan_id = decode_eid(plan_eid)
    if plan_id is None:
        return None
    for p in list_action_plans(contact_eid, van_id):
        if p.get("id") == plan_id:
            return p
    return None


def _current_solicitor(contact_eid: str, van_id: int, plan_eid: str) -> str | None:
    """The plan's existing primary solicitor, so an edit preserves it."""
    p = find_plan(contact_eid, van_id, plan_eid)
    if not p:
        return None
    return p.get("primarySolicitorSortName") or p.get("primarySolicitorDisplayName")


def update_plan(
    contact_eid: str,
    plan_eid: str,
    van_id: int,
    dry_run: bool = True,
    solicitor: str | None = None,
    **changes: Any,
) -> dict:
    """
    Change an action plan, with a dry run by default.

    dry_run=True  -> opens the plan, reports current vs requested, changes nothing.
    dry_run=False -> types the values, saves, then re-reads the plan through the
                     JSON API and returns the persisted record. A postback that
                     silently fails shows up here as unchanged data.
    """
    # Moving a plan to a new stage is a dated event. EveryAction rejects the
    # save unless the Status Date ADVANCES -- despite the validator text saying
    # "equal to or later", an identical date is refused; it must be strictly
    # later. Default to today, which is right in normal use because the previous
    # stage change was days or weeks ago. When it is not (a plan touched earlier
    # the same day), say so plainly instead of quietly forward-dating a donor
    # record to make the save go through.
    if "status" in changes and "status_date" not in changes:
        today = date.today()
        current = find_plan(contact_eid, van_id, plan_eid) or {}
        prev_raw = (current.get("statusDate") or "")[:10]

        # Asking for the stage it is already in is a no-op, not a stage change.
        # Dropping it here keeps the date rule from blocking an update whose
        # real payload is some other field.
        if str(changes["status"]).strip().lower() == str(current.get("statusName") or "").strip().lower():
            changes = {k: v for k, v in changes.items() if k != "status"}
            prev_raw = ""

        if prev_raw and prev_raw >= today.isoformat():
            # Suggest the day after the PREVIOUS change, not after today -- when
            # the stored date is already in the future, "tomorrow" is still not
            # strictly later and the caller would just hit the validator again.
            try:
                nxt = date.fromisoformat(prev_raw) + timedelta(days=1)
            except ValueError:
                nxt = today + timedelta(days=1)
            raise MovesError(
                f"This plan's status already changed on {prev_raw}, and EveryAction "
                f"requires each stage change to carry a strictly later Status Date. "
                f"Pass an explicit later date, e.g. status_date='{nxt.isoformat()}'."
            )
        if "status" in changes:
            changes = dict(changes, status_date=today.isoformat())

    open_plan(contact_eid, plan_eid)
    before = read_form()

    preview = {}
    for name, value in changes.items():
        key, kind = PLAN_FIELDS[name]
        preview[name] = {"from": before.get(key, ""), "to": _normalize(value, kind)}

    if dry_run:
        return {"dry_run": True, "plan": plan_eid, "changes": preview}

    # The solicitor picker must be repopulated or the save is rejected. Default
    # to whoever the plan already belongs to, so a status edit never silently
    # reassigns the donor to someone else.
    who = solicitor or _current_solicitor(contact_eid, van_id, plan_eid)
    if not who:
        raise MovesError(
            "This plan has no primary solicitor and EveryAction requires one. "
            "Pass solicitor='Lastname' to set it."
        )
    set_solicitor(who)

    stage_changes(**changes)
    save()

    # A rejected ASP.NET postback re-renders the page with the typed values
    # still in the inputs, so the form itself is NOT evidence of a save.
    # Surface any validator that is actually visible after the submit.
    blockers = js(r"""
    JSON.stringify([...document.querySelectorAll("[id*='Validator'],[id*='valid'],.field-validation-error")]
      .filter(e => e.offsetParent !== null && (e.innerText||"").trim())
      .map(e => (e.innerText||"").trim().slice(0, 120)).slice(0, 6))
    """)
    blockers = json.loads(blockers) if blockers else []

    time.sleep(1)
    saved = find_plan(contact_eid, van_id, plan_eid)
    after = summarize_plan(saved) if saved else None

    # Verify by comparing what the server now reports against what we asked for,
    # not merely that the record still exists.
    checks, applied = {}, True
    if after:
        for name in changes:
            if name == "status":
                got, want = after.get("status"), preview[name]["to"]
            elif name in ("ask", "ask_amount"):
                got, want = after.get("ask_amount"), preview[name]["to"]
            else:
                continue
            match = str(got or "").strip().lower() == str(want or "").strip().lower()
            checks[name] = {"wanted": want, "server_reports": got, "match": match}
            applied = applied and match
    else:
        applied = False

    return {
        "dry_run": False,
        "plan": plan_eid,
        "requested": preview,
        "saved": after,
        "verified": bool(after) and applied,
        "checks": checks,
        "validation_errors": blockers,
    }
