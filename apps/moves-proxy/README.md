# EveryAction Moves Management proxy

Lets Mobile Baykeeper staff read and change **Moves Management** — action plans
and scheduled follow-ups — from Claude Desktop, working through the browser
session they are already signed in to.

## Why this exists

Moves Management *is* in EveryAction's API. It is simply not granted to API-key
auth, and it is not documented. Our key gets:

| Route | API key | Browser session |
|---|---|---|
| `/v4/contactRecords/{id}/actionPlans` | `403 FORBIDDEN` | works |
| `/v4/portfolioManagement/actionPlans/{portfolioId}` | `403 FORBIDDEN` | works |
| `/v4/users?matchName=` | `403 FORBIDDEN` | works |
| `/v4/omniSearchSuggestions?q=` | `403 FORBIDDEN` | works |
| `/v4/people/{vanId}/activities?activityTypes=FollowUp` | **works** | works |

A `403` means the route exists and the key lacks scope; a bare IIS `404` means no
such route. That difference is how the surface above was mapped.

**If Bonterra ever widens the key's scope, most of this can move into the hosted
MCP and this local proxy can be retired.** That request is worth making: it is a
concrete, route-level ask, not a feature question.

## How it works

```
Claude Desktop ──stdio──► mcp_server.py ──subprocess──► browser-harness
                                                            │  CDP
                                                            ▼
                                              your signed-in Chrome ──► EveryAction
```

- **Reads** go through the internal `/v4` JSON API, executed inside a logged-in
  tab. Structured and selector-free.
- **Writes** go through `ActionPlanDetails.aspx` and `ContactHistoryDetails.aspx`,
  which are classic ASP.NET WebForms. There is no JSON write endpoint. We drive
  the real form and let the browser round-trip ViewState rather than forging it.
- **Every write is verified** by reading server state back through the JSON API.
  A rejected postback re-renders with your typed values still in the inputs, so
  the form is *not* evidence of a save.

No credentials are stored or requested. If the session lapses the tools say so
and ask the person to sign in. A useful side effect: changes are attributed to
the real person in EveryAction's audit trail, not a shared service account.

## Install

```bash
./install.sh
```

Installs uv and browser-harness if missing, creates the server venv, registers
with Claude Desktop, and checks the Chrome attachment. Then sign in to
EveryAction in Chrome, restart Claude, and ask *"check my EveryAction session"*.

## Traps

Each of these cost real debugging time. They are guarded in code; this is the
explanation.

**A numeric plan id silently opens a blank CREATE form.** `ActionPlanDetails.aspx`
addresses plans by an opaque EID (`EID4321Z`). Given an id it does not recognise
it falls back to a new-plan form prefilled with today's date and the first
status — which looks exactly like a loaded plan. Saving then creates a duplicate
instead of updating. `open_plan()` refuses non-EID ids and verifies the landed
URL. *This produced three junk plans before it was caught.*

**Contact EIDs can be computed; plan EIDs cannot.** The encoding is `EID` +
reverse(check-char + uppercase-hex-id). For contacts the check character is
`chr(65 + vanId % 17)` — verified 11/11 against live records plus an end-to-end
load of a constructed id — so `encode_contact_eid()` turns a numeric VanID
straight into a working `Contact.aspx` link with no lookup. Plans do **not**
follow that rule (a plan decoding to 4660 carries `Z`, where the contact rule
gives `C`), so plan ids still have to come from `plan_eids()`.

The numeric id is not interchangeable with the encoded one in a URL:
`Contact.aspx?VanID=<numeric>` redirects to `Error.aspx`, while
`Contact.aspx?VanID=EID<encoded>` loads the record. The query parameter is named
`VanID` but wants the EID.

**The Primary Solicitor picker is empty on page load.** It is a select2 whose
backing input starts blank even when the plan has a solicitor, so an untouched
form fails validation with "Please enter a Primary Solicitor" and the postback is
silently rejected. `update_plan()` repopulates it from the plan's existing owner
before every save.

**Stage changes need a strictly later Status Date.** Despite the validator saying
"equal to or later", an identical date is refused. Defaults to today, which is
correct in normal use; refuses rather than forward-dating a record when the plan
already moved today.

**Readiness / Likelihood / Capacity are 0–999 scores**, not labels. "High" fails.

**Some controls AutoPostBack.** Setting Follow Up How reloads the page, discarding
anything typed after it. Fields are set selects-first, then re-read and re-applied.

**browser-harness silently returns `None` for some snippets.** `js()` wraps any
expression containing `return` in `(function(){...})()` *unless it already starts
with `(`* — and the wrapped body's trailing expression evaluates to undefined. A
snippet with `return` inside an arrow callback comes back as `None` with no error,
which reads exactly like "no results". **Write every snippet as an IIFE starting
with `(`.**

**Never let an exception escape a tool.** An error raised out of an MCP tool
reaches the model as an opaque "error executing tool", losing the message that
names the fix. In testing this turned a one-line problem ("pass a later status
date") into a long false-trail investigation blaming the DOM. Tools return
`{"ok": false, "error": ...}` so the text survives; `_guarded` in `mcp_server.py`
enforces it.

**A plan's `nextDueDate` is not a queue indicator.** It stays null even when
follow-ups are correctly attached to the plan, so never use it to decide whether
anything is scheduled — doing so reports working links as broken. The contact's
activities feed also returns follow-ups with no plan reference at all.

**Plan⇄follow-up attachment is only visible on the plan page.** Each attached
follow-up renders Cancel and Delete links carrying its own encoded id (`CFUID`).
`plan_followups()` reads those; it is the only reliable way to confirm the link,
and the only source of the id needed to delete a follow-up.

**Modal pages do nothing when opened directly.** The follow-up delete
confirmation is `type="button"` with
`onclick="GetRadWindow().Close(); __doPostBack(...)"`. Outside its Telerik
RadWindow, `GetRadWindow()` throws and the exception short-circuits the
`__doPostBack` that does the work — so the click looks fine and deletes nothing.

**Do not call `__doPostBack` from evaluated JS.** ASP.NET's AJAX build inspects
`arguments.callee`, which throws when called from a strict-mode function. Set
`__EVENTTARGET` / `__EVENTARGUMENT` and submit the form instead.

**Pin the browser tab.** The harness's current tab follows Chrome's *active* tab.
With several EveryAction tabs open — or the user clicking around — a relative
`fetch()` executes against whatever is focused and returns a 200 with HTML from
the wrong site. `ea_session` pins one target for the life of the process.

**The app is sharded.** `app5.everyaction.com`, not `app.` — the generic host 404s.
The origin is read from the live tab rather than hardcoded.

## Files

| File | |
|---|---|
| `ea_session.py` | tab pinning, origin discovery, authenticated `/v4` calls |
| `ea_moves.py` | action plans and follow-ups: read, preview, write, verify |
| `mcp_server.py` | MCP tools for Claude Desktop |
| `install.sh` | one-shot setup |
| `run_edit.py`, `run_followup.py` | standalone runners for manual testing |
