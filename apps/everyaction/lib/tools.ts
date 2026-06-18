import { EAClient, EAInteraction } from "./ea-client";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function formatPerson(p: {
  vanId: number;
  firstName: string | null;
  lastName: string | null;
  emails?: Array<{ email: string }>;
  phones?: Array<{ phoneNumber: string }>;
}) {
  const name = [p.firstName, p.lastName].filter(Boolean).join(" ") || "(no name)";
  const email = p.emails?.[0]?.email ?? "-";
  const phone = p.phones?.[0]?.phoneNumber ?? "-";
  return `VAN ${p.vanId}: ${name} | ${email} | ${phone}`;
}

function formatNote(n: {
  noteId?: number;
  text: string;
  createdByName?: string;
  dateCreated?: string;
  createdDate?: string;
}) {
  const rawDate = n.createdDate ?? n.dateCreated;
  let date = "?";
  if (rawDate) {
    const d = new Date(rawDate);
    date = isNaN(d.getTime())
      ? rawDate
      : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }
  const author = n.createdByName ?? "Unknown";
  return `[${date} - ${author}] ${n.text}`;
}

function formatInteraction(i: EAInteraction): string {
  const date = i.dateCanvassed
    ? new Date(i.dateCanvassed).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : "?";
  const type = i.contactTypeName ?? `Type ID ${i.contactTypeId ?? "?"}`;
  const result = i.resultCodeName ?? (i.resultCodeId ? `Result ID ${i.resultCodeId}` : "No result recorded");
  const by = i.createdByName ? ` by ${i.createdByName}` : "";
  const note = i.notes?.[0]?.text
    ? `\n  Note: "${i.notes[0].text.slice(0, 120)}${i.notes[0].text.length > 120 ? "..." : ""}"`
    : "";
  return `[${date}${by}] ${type} -- ${result}${note}`;
}

function uniqueNumbers(values: number[]) {
  return Array.from(new Set(values.filter((v) => Number.isFinite(v))));
}

// ---------------------------------------------------------------------------
// Tool registry (for tools/list)
// ---------------------------------------------------------------------------

export const TOOLS: McpTool[] = [
  {
    name: "ea_validate_connection",
    description: "Validate that the EveryAction credentials are working.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ea_list_activist_codes",
    description: "List activist codes so operators can discover portfolio tag names and IDs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional filter string" },
        limit: { type: "number", description: "Max results (default 50)" },
      },
    },
  },
  {
    name: "ea_list_contact_types",
    description: "List all EveryAction contact types (Phone, Meeting, Virtual Meeting, etc.).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ea_search_contacts",
    description: "Search EveryAction contacts by name, email, or phone.",
    inputSchema: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
      },
    },
  },
  {
    name: "ea_get_contact",
    description: "Get contact details and recent notes for a VAN ID.",
    inputSchema: {
      type: "object",
      properties: { vanId: { type: "number" } },
      required: ["vanId"],
    },
  },
  {
    name: "ea_get_contact_history",
    description: "Get the 25 most recent notes on a contact record.",
    inputSchema: {
      type: "object",
      properties: { vanId: { type: "number" } },
      required: ["vanId"],
    },
  },
  {
    name: "ea_get_interaction_history",
    description: "Get the 25 most recent logged interactions (contact history) for a contact.",
    inputSchema: {
      type: "object",
      properties: { vanId: { type: "number" } },
      required: ["vanId"],
    },
  },
  {
    name: "ea_stage_interaction",
    description:
      "Dry-run validator for logging an interaction. Call this first when a user describes a contact they had. Resolves the contact, checks required fields, and returns a staging review showing what is confirmed and what is still needed. Always show the review to the user before logging.",
    inputSchema: {
      type: "object",
      properties: {
        vanId: { type: "number", description: "VAN ID if known" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        contactTypeName: { type: "string", description: "e.g. Phone, Meeting, Virtual Meeting, House Visit" },
        contactTypeId: { type: "number" },
        date: { type: "string", description: "ISO date (defaults to today)" },
        time: { type: "string" },
        resultCodeId: { type: "number" },
        resultCodeName: { type: "string" },
        contactedBy: { type: "string" },
        note: { type: "string" },
        noteCategory: { type: "string" },
      },
    },
  },
  {
    name: "ea_log_note",
    description: "Log a note on a contact record in EveryAction.",
    inputSchema: {
      type: "object",
      properties: {
        vanId: { type: "number" },
        note: { type: "string" },
        isPrivate: { type: "boolean" },
      },
      required: ["vanId", "note"],
    },
  },
  {
    name: "ea_log_interaction",
    description:
      "Log a typed interaction on a contact record. Use contactTypeName for the full EA list (Phone, Meeting, Virtual Meeting, House Visit, One on One, etc.). Always run ea_stage_interaction first.",
    inputSchema: {
      type: "object",
      properties: {
        vanId: { type: "number" },
        contactTypeName: { type: "string", description: "EA contact type name (e.g. Phone, Meeting)" },
        note: { type: "string" },
        date: { type: "string", description: "ISO date (defaults to today)" },
        resultCodeId: { type: "number" },
      },
      required: ["vanId"],
    },
  },
  {
    name: "ea_find_or_create_contact",
    description: "Find an existing contact or create one if they do not exist yet.",
    inputSchema: {
      type: "object",
      properties: {
        firstName: { type: "string" },
        lastName: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        employer: { type: "string" },
      },
      required: ["firstName", "lastName"],
    },
  },
  {
    name: "ea_get_portfolio_summary",
    description: "Summarize a donor portfolio by activist code or explicit VAN IDs.",
    inputSchema: {
      type: "object",
      properties: {
        activistCodeName: { type: "string" },
        activistCodeId: { type: "number" },
        notContactedInDays: { type: "number" },
        vanIds: { type: "array", items: { type: "number" } },
        limit: { type: "number" },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  client: EAClient
): Promise<ToolResult> {
  try {
    switch (name) {
      case "ea_validate_connection": {
        await client.validateConnection();
        return ok("EveryAction connection validated successfully.");
      }

      case "ea_list_activist_codes": {
        const limit = (args.limit as number | undefined) ?? 50;
        const query = (args.query as string | undefined)?.trim().toLowerCase();
        const result = await client.listActivistCodes(limit);
        const items = (result.items ?? []).filter((item) => {
          if (!query) return true;
          const label = (item.name ?? item.activistCodeName ?? "").toLowerCase();
          return label.includes(query);
        });
        if (!items.length) return ok(query ? `No activist codes matched "${query}".` : "No activist codes returned.");
        return ok(items.map((item) => `${item.activistCodeId}: ${item.name ?? item.activistCodeName ?? "(unnamed)"}`).join("\n"));
      }

      case "ea_list_contact_types": {
        const result = await client.listContactTypes();
        const items = result.items ?? [];
        if (!items.length) return ok("No contact types returned.");
        return ok(items.map((item) => `${item.contactTypeId}: ${item.name ?? item.contactTypeName ?? "(unnamed)"}`).join("\n"));
      }

      case "ea_search_contacts": {
        const result = await client.findPeople({
          firstName: args.firstName as string | undefined,
          lastName: args.lastName as string | undefined,
          email: args.email as string | undefined,
          phone: args.phone as string | undefined,
        });
        if (!result.items?.length) return ok("No contacts found.");
        return ok(`Found ${result.count} match(es):\n${result.items.map(formatPerson).join("\n")}`);
      }

      case "ea_get_contact": {
        const vanId = args.vanId as number;
        const { person, recentNotes } = await client.getContactSummary(vanId);
        const name = [person.firstName, person.lastName].filter(Boolean).join(" ") || "(no name)";
        const email = person.emails?.find((e) => e.isPrimary)?.email ?? person.emails?.[0]?.email ?? "-";
        const phone = person.phones?.[0]?.phoneNumber ?? "-";
        const addr = person.addresses?.find((a) => a.isPrimary) ?? person.addresses?.[0];
        const addrStr = addr ? [addr.city, addr.stateOrProvince].filter(Boolean).join(", ") : "-";
        const header = `${name}\nVAN ID: ${vanId} | Email: ${email} | Phone: ${phone} | Location: ${addrStr}`;
        const notesSection = recentNotes.length
          ? "\n\nRecent notes:\n" + recentNotes.map(formatNote).join("\n")
          : "\n\nNo notes on file.";
        return ok(header + notesSection);
      }

      case "ea_get_contact_history": {
        const vanId = args.vanId as number;
        const notes = await client.getNotes(vanId);
        if (!notes.items?.length) return ok("No notes on file for this contact.");
        return ok(`${notes.count} note(s) on file:\n\n${notes.items.map(formatNote).join("\n\n")}`);
      }

      case "ea_get_interaction_history": {
        const vanId = args.vanId as number;
        const result = await client.getInteractions(vanId);
        if (!result.items?.length) return ok("No interaction history on file for this contact.");
        return ok(`${result.count ?? result.items.length} interaction(s) on file:\n\n${result.items.map(formatInteraction).join("\n\n")}`);
      }

      case "ea_stage_interaction": {
        const lines: string[] = ["INTERACTION STAGING REVIEW", "─".repeat(40), ""];
        const missing: string[] = [];
        const warnings: string[] = [];

        let vanId = args.vanId as number | undefined;
        let contactDisplay = "";
        if (!vanId) {
          const firstName = args.firstName as string | undefined;
          const lastName = args.lastName as string | undefined;
          if (!firstName && !lastName) {
            missing.push("Contact -- provide vanId, or firstName + lastName to search");
          } else {
            const found = await client.findPeople({ firstName, lastName });
            if (!found.items?.length) {
              missing.push(`Contact -- "${[firstName, lastName].filter(Boolean).join(" ")}" not found`);
            } else if (found.items.length > 1) {
              missing.push(`Contact -- matched ${found.items.length} records; provide vanId to disambiguate`);
            } else {
              vanId = found.items[0].vanId;
              const n = found.items[0];
              contactDisplay = `${[n.firstName, n.lastName].filter(Boolean).join(" ")} (VAN ${vanId})`;
            }
          }
        } else {
          try {
            const person = await client.getPerson(vanId);
            contactDisplay = `${[person.firstName, person.lastName].filter(Boolean).join(" ")} (VAN ${vanId})`;
          } catch { contactDisplay = `VAN ${vanId}`; }
        }
        lines.push(`Contact:       ${contactDisplay || "[MISSING]"}`);

        const date = (args.date as string | undefined) ?? new Date().toISOString().split("T")[0];
        lines.push(`Date:          ${date}`);
        lines.push(`Time:          ${(args.time as string | undefined) ?? "(not provided)"}`);

        let contactTypeId = args.contactTypeId as number | undefined;
        let contactTypeLabel = args.contactTypeName as string | undefined;
        if (!contactTypeId && contactTypeLabel) {
          const ct = await client.findContactTypeByName(contactTypeLabel);
          if (ct) {
            contactTypeId = ct.contactTypeId;
            contactTypeLabel = ct.name ?? ct.contactTypeName ?? contactTypeLabel;
          } else {
            missing.push(`Contacted how -- "${contactTypeLabel}" not found; run ea_list_contact_types to see options`);
            contactTypeLabel = undefined;
          }
        } else if (!contactTypeId) {
          missing.push("Contacted how -- provide contactTypeName (e.g. Phone, Meeting, Virtual Meeting)");
        }
        lines.push(`Contacted how: ${contactTypeLabel ? `${contactTypeLabel} (ID ${contactTypeId})` : "[MISSING]"}`);

        const resultCodeId = args.resultCodeId as number | undefined;
        const resultCodeName = args.resultCodeName as string | undefined;
        if (contactTypeId && !resultCodeId && !resultCodeName) {
          try {
            const rcResult = await client.listResultCodes(contactTypeId);
            const codes = (rcResult.items ?? []).slice(0, 8);
            if (codes.length) {
              warnings.push(`No result provided. Options: ${codes.map((c) => c.name ?? c.resultCodeName).filter(Boolean).join(", ")}`);
            }
          } catch { /* non-fatal */ }
        }
        lines.push(`Result:        ${resultCodeName ?? (resultCodeId ? `ID ${resultCodeId}` : "(not provided)")}`);
        lines.push(`Contacted by:  ${(args.contactedBy as string | undefined) ?? "(not provided)"}`);

        const note = args.note as string | undefined;
        if (!note) warnings.push("No note text provided -- allowed but not recommended");
        lines.push(`Note:          ${note ? `"${note.slice(0, 120)}${note.length > 120 ? "..." : ""}"` : "(none)"}`);
        lines.push(`Note category: ${(args.noteCategory as string | undefined) ?? "(not provided)"}`);

        lines.push("", "─".repeat(40));
        if (missing.length) {
          lines.push(`STATUS: NOT READY -- ${missing.length} required item(s) missing`, "");
          missing.forEach((m) => lines.push(`  MISSING: ${m}`));
        } else {
          lines.push("STATUS: READY TO LOG");
        }
        if (warnings.length) {
          lines.push("");
          warnings.forEach((w) => lines.push(`  NOTE: ${w}`));
        }

        return ok(lines.join("\n"));
      }

      case "ea_log_note": {
        const vanId = args.vanId as number;
        const note = args.note as string;
        const isPrivate = (args.isPrivate as boolean | undefined) ?? false;
        const result = await client.addNote(vanId, note, isPrivate);
        return ok(`Note logged on VAN ${vanId}.\nID: ${result?.noteId ?? "(saved)"}\nText: "${note.slice(0, 120)}${note.length > 120 ? "..." : ""}"`);
      }

      case "ea_log_interaction": {
        const vanId = args.vanId as number;
        const note = (args.note as string | undefined) ?? "";
        const date = args.date as string | undefined;
        const resultCodeId = args.resultCodeId as number | undefined;
        const contactTypeName = args.contactTypeName as string | undefined;

        if (!contactTypeName) return err("Provide contactTypeName (e.g. Phone, Meeting, Virtual Meeting).");

        const ct = await client.findContactTypeByName(contactTypeName);
        if (!ct) return err(`Contact type "${contactTypeName}" not found. Run ea_list_contact_types to see options.`);

        await client.logContactFull(vanId, { contactTypeId: ct.contactTypeId, dateCanvassed: date, resultCodeId, noteText: note });
        if (note) await client.addNote(vanId, `[${ct.name ?? ct.contactTypeName}] ${note}`);

        return ok(`Logged "${ct.name ?? ct.contactTypeName}" on VAN ${vanId}${date ? ` (${date})` : " (today)"}.`);
      }

      case "ea_find_or_create_contact": {
        const result = await client.upsertPerson({
          firstName: args.firstName as string,
          lastName: args.lastName as string,
          email: args.email as string | undefined,
          phone: args.phone as string | undefined,
          employer: args.employer as string | undefined,
        });
        return ok(`${result.isDuplicate ? "Found existing" : "Created new"} contact: VAN ID ${result.vanId}`);
      }

      case "ea_get_portfolio_summary": {
        const inputVanIds = args.vanIds as number[] | undefined;
        const activistCodeName = args.activistCodeName as string | undefined;
        const activistCodeId = args.activistCodeId as number | undefined;
        const notTouchedInDays = args.notContactedInDays as number | undefined;
        const limit = (args.limit as number | undefined) ?? 100;

        let vanIds = uniqueNumbers(inputVanIds ?? []);
        let portfolioSource = vanIds.length ? "explicit VAN IDs" : "";

        if (!vanIds.length) {
          let resolvedId = activistCodeId;
          if (!resolvedId && activistCodeName) {
            const code = await client.findActivistCodeByName(activistCodeName);
            if (!code) return ok(`No activist code matched "${activistCodeName}".`);
            resolvedId = code.activistCodeId;
            portfolioSource = `activist code "${code.name ?? code.activistCodeName ?? activistCodeName}"`;
          }
          if (!resolvedId) return ok("ea_get_portfolio_summary requires vanIds, activistCodeName, or activistCodeId.");
          const people = await client.listPeopleByActivistCode(resolvedId, limit);
          vanIds = uniqueNumbers((people.items ?? []).map((p) => p.vanId));
          portfolioSource = portfolioSource || `activist code ID ${resolvedId}`;
          if (!vanIds.length) return ok(`No contacts found for ${portfolioSource}.`);
        }

        type Row = { summary: string; daysSince: number | null };
        const summaries = await Promise.all(
          vanIds.map(async (vanId): Promise<Row | null> => {
            try {
              const [person, notes] = await Promise.all([client.getPerson(vanId), client.getNotes(vanId)]);
              const name = [person.firstName, person.lastName].filter(Boolean).join(" ") || "(no name)";
              const lastNote = notes.items[0];
              const rawDate = lastNote?.createdDate ?? lastNote?.dateCreated;
              const lastTouched = rawDate ? new Date(rawDate) : null;
              const daysSince = lastTouched ? Math.floor((Date.now() - lastTouched.getTime()) / 86_400_000) : null;
              if (notTouchedInDays && daysSince !== null && daysSince < notTouchedInDays) return null;
              const status = daysSince === null ? "NEVER LOGGED" : daysSince > 30 ? `STALE ${daysSince}d` : daysSince > 14 ? `AGING ${daysSince}d` : `RECENT ${daysSince}d`;
              const lastNoteText = lastNote?.text ? lastNote.text.slice(0, 100) + (lastNote.text.length > 100 ? "..." : "") : "(no notes)";
              return { daysSince, summary: `${name} (VAN ${vanId})\n  Status: ${status}\n  Last: ${lastNoteText}` };
            } catch (e) {
              return { daysSince: null, summary: `VAN ${vanId}: error (${e instanceof Error ? e.message : String(e)})` };
            }
          })
        );

        const results = (summaries.filter(Boolean) as Row[]).sort((a, b) => (b.daysSince ?? Infinity) - (a.daysSince ?? Infinity));
        if (!results.length) return ok("All portfolio contacts have been touched recently.");
        return ok(`Portfolio summary from ${portfolioSource} (${results.length} of ${vanIds.length} contacts):\n\n${results.map((r) => r.summary).join("\n\n")}`);
      }

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
