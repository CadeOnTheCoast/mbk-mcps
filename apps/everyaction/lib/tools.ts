import { EAClient, EACustomField, EACustomFieldValue, EAInteraction } from "./ea-client";

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
    name: "ea_update_contact",
    description:
      "Update structured fields on an existing contact: name parts, employer, title/occupation, suffix, date of birth. Use ea_add_contact_email / ea_add_contact_phone / ea_update_contact_address for contact info. NOTE: EveryAction's freeform 'Biography' panel is NOT writable via the API — put biographical narrative in a note via ea_log_note instead.",
    inputSchema: {
      type: "object",
      properties: {
        vanId: { type: "number" },
        firstName: { type: "string" },
        lastName: { type: "string" },
        middleName: { type: "string" },
        suffix: { type: "string", description: "e.g. Jr., Sr., III" },
        employer: { type: "string" },
        occupation: { type: "string", description: "Job title / role" },
        dateOfBirth: { type: "string", description: "ISO date (YYYY-MM-DD)" },
      },
      required: ["vanId"],
    },
  },
  {
    name: "ea_merge_contacts",
    description:
      "Merge a duplicate contact into the record you want to keep. The source record is permanently deleted and its history moves to the surviving record. Use this to clean up duplicates.",
    inputSchema: {
      type: "object",
      properties: {
        sourceVanId: { type: "number", description: "The duplicate to delete (its data merges into the keeper)" },
        keepVanId: { type: "number", description: "The record that survives" },
      },
      required: ["sourceVanId", "keepVanId"],
    },
  },
  {
    name: "ea_add_contact_email",
    description: "Add an email address to a contact record.",
    inputSchema: {
      type: "object",
      properties: {
        vanId: { type: "number" },
        email: { type: "string" },
        isPrimary: { type: "boolean", description: "Mark as primary email (default false)" },
      },
      required: ["vanId", "email"],
    },
  },
  {
    name: "ea_add_contact_phone",
    description: "Add a phone number to a contact record.",
    inputSchema: {
      type: "object",
      properties: {
        vanId: { type: "number" },
        phoneNumber: { type: "string" },
        phoneType: { type: "string", description: "C=Cell, H=Home, W=Work, M=Mobile (default C)" },
        isPrimary: { type: "boolean" },
      },
      required: ["vanId", "phoneNumber"],
    },
  },
  {
    name: "ea_update_contact_address",
    description: "Add or update a mailing address on a contact record.",
    inputSchema: {
      type: "object",
      properties: {
        vanId: { type: "number" },
        addressLine1: { type: "string" },
        addressLine2: { type: "string" },
        city: { type: "string" },
        stateOrProvince: { type: "string", description: "Two-letter state abbreviation" },
        zipOrPostalCode: { type: "string" },
        isPrimary: { type: "boolean" },
      },
      required: ["vanId", "addressLine1"],
    },
  },
  {
    name: "ea_apply_activist_code",
    description: "Apply (tag) an activist code to a contact. Use ea_list_activist_codes to find code names/IDs.",
    inputSchema: {
      type: "object",
      properties: {
        vanId: { type: "number" },
        activistCodeId: { type: "number" },
        activistCodeName: { type: "string", description: "Name to resolve if ID not known" },
      },
      required: ["vanId"],
    },
  },
  {
    name: "ea_remove_activist_code",
    description: "Remove (untag) an activist code from a contact.",
    inputSchema: {
      type: "object",
      properties: {
        vanId: { type: "number" },
        activistCodeId: { type: "number" },
        activistCodeName: { type: "string" },
      },
      required: ["vanId"],
    },
  },
  {
    name: "ea_list_contact_activist_codes",
    description: "List all activist codes (tags) currently applied to a contact.",
    inputSchema: {
      type: "object",
      properties: { vanId: { type: "number" } },
      required: ["vanId"],
    },
  },
  {
    name: "ea_list_custom_fields",
    description: "List all custom fields defined in this EveryAction organization (e.g. Bio, Notes, custom attributes). Use this to find customFieldId values before calling ea_set_custom_field.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ea_get_custom_field_values",
    description: "Get all custom field values set on a contact record.",
    inputSchema: {
      type: "object",
      properties: { vanId: { type: "number" } },
      required: ["vanId"],
    },
  },
  {
    name: "ea_set_custom_field",
    description: "Set a custom field value on a contact (e.g. Bio, any org-defined attribute). Run ea_list_custom_fields first to find the right customFieldId.",
    inputSchema: {
      type: "object",
      properties: {
        vanId: { type: "number" },
        customFieldId: { type: "number" },
        customFieldName: { type: "string", description: "Name to resolve if ID not known" },
        value: { type: "string" },
      },
      required: ["vanId", "value"],
    },
  },
  {
    name: "ea_get_contact_full",
    description: "Get a complete contact record: core fields, all emails/phones/addresses, activist codes, and custom field values in one call.",
    inputSchema: {
      type: "object",
      properties: { vanId: { type: "number" } },
      required: ["vanId"],
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

      case "ea_update_contact": {
        const vanId = args.vanId as number;
        const fields = ["firstName","lastName","middleName","suffix","employer","occupation","dateOfBirth"] as const;
        const updates: Record<string, string> = {};
        for (const f of fields) {
          if (args[f] !== undefined) updates[f] = args[f] as string;
        }
        if (!Object.keys(updates).length) return err("Provide at least one field to update.");
        await client.updatePerson(vanId, updates);
        return ok(`Updated VAN ${vanId}: ${Object.entries(updates).map(([k,v]) => `${k}="${v}"`).join(", ")}`);
      }

      case "ea_merge_contacts": {
        const sourceVanId = args.sourceVanId as number;
        const keepVanId = args.keepVanId as number;
        if (sourceVanId === keepVanId) return err("sourceVanId and keepVanId must differ.");
        await client.mergeInto(sourceVanId, keepVanId);
        return ok(`Merged VAN ${sourceVanId} into VAN ${keepVanId}. VAN ${sourceVanId} is now deleted; its history lives on VAN ${keepVanId}.`);
      }

      case "ea_add_contact_email": {
        const vanId = args.vanId as number;
        const email = args.email as string;
        const isPrimary = (args.isPrimary as boolean | undefined) ?? false;
        await client.addEmail(vanId, email, isPrimary);
        return ok(`Added email "${email}" to VAN ${vanId}${isPrimary ? " (set as primary)" : ""}.`);
      }

      case "ea_add_contact_phone": {
        const vanId = args.vanId as number;
        const phoneNumber = args.phoneNumber as string;
        const phoneType = (args.phoneType as string | undefined) ?? "C";
        const isPrimary = (args.isPrimary as boolean | undefined) ?? false;
        await client.addPhone(vanId, phoneNumber, phoneType, isPrimary);
        return ok(`Added phone "${phoneNumber}" (${phoneType}) to VAN ${vanId}.`);
      }

      case "ea_update_contact_address": {
        const vanId = args.vanId as number;
        await client.addAddress(vanId, {
          addressLine1: args.addressLine1 as string,
          addressLine2: args.addressLine2 as string | undefined,
          city: args.city as string | undefined,
          stateOrProvince: args.stateOrProvince as string | undefined,
          zipOrPostalCode: args.zipOrPostalCode as string | undefined,
          isPrimary: (args.isPrimary as boolean | undefined) ?? false,
        });
        const parts = [args.addressLine1, args.city, args.stateOrProvince, args.zipOrPostalCode].filter(Boolean);
        return ok(`Added address "${parts.join(", ")}" to VAN ${vanId}.`);
      }

      case "ea_apply_activist_code": {
        const vanId = args.vanId as number;
        let codeId = args.activistCodeId as number | undefined;
        let codeName = args.activistCodeName as string | undefined;
        if (!codeId) {
          if (!codeName) return err("Provide activistCodeId or activistCodeName.");
          const code = await client.findActivistCodeByName(codeName);
          if (!code) return err(`No activist code matched "${codeName}". Run ea_list_activist_codes to see options.`);
          codeId = code.activistCodeId;
          codeName = code.name ?? code.activistCodeName ?? codeName;
        }
        await client.applyActivistCode(vanId, codeId);
        return ok(`Applied activist code "${codeName ?? codeId}" (ID ${codeId}) to VAN ${vanId}.`);
      }

      case "ea_remove_activist_code": {
        const vanId = args.vanId as number;
        let codeId = args.activistCodeId as number | undefined;
        const codeName = args.activistCodeName as string | undefined;
        if (!codeId) {
          if (!codeName) return err("Provide activistCodeId or activistCodeName.");
          const code = await client.findActivistCodeByName(codeName);
          if (!code) return err(`No activist code matched "${codeName}".`);
          codeId = code.activistCodeId;
        }
        await client.removeActivistCode(vanId, codeId);
        return ok(`Removed activist code ${codeId} from VAN ${vanId}.`);
      }

      case "ea_list_contact_activist_codes": {
        const vanId = args.vanId as number;
        const result = await client.listContactActivistCodes(vanId);
        const items = result.items ?? [];
        if (!items.length) return ok(`VAN ${vanId} has no activist codes applied.`);
        return ok(`Activist codes on VAN ${vanId}:\n${items.map((c) => `  ${c.activistCodeId}: ${c.activistCodeName}`).join("\n")}`);
      }

      case "ea_list_custom_fields": {
        const result = await client.listCustomFields();
        const items = result.items ?? [];
        if (!items.length) return ok("No custom fields defined in this organization.");
        const format = (f: EACustomField) => {
          const name = f.name ?? f.customFieldName ?? "(unnamed)";
          const type = f.type ? ` [${f.type}]` : "";
          const values = f.availableValues?.length
            ? `\n    Options: ${f.availableValues.map((v) => `${v.id}=${v.name}`).join(", ")}`
            : "";
          return `  ${f.customFieldId}: ${name}${type}${values}`;
        };
        return ok(`Custom fields (${items.length}):\n${items.map(format).join("\n")}`);
      }

      case "ea_get_custom_field_values": {
        const vanId = args.vanId as number;
        const result = await client.getCustomFieldValues(vanId);
        const items = result.items ?? [];
        if (!items.length) return ok(`No custom field values set on VAN ${vanId}.`);
        const fieldDefs = (await client.listCustomFields()).items ?? [];
        const nameMap = new Map(fieldDefs.map((f) => [f.customFieldId, f.name ?? f.customFieldName ?? String(f.customFieldId)]));
        const format = (v: EACustomFieldValue) => {
          const name = nameMap.get(v.customFieldId) ?? String(v.customFieldId);
          return `  ${name} (${v.customFieldId}): ${v.assignedValue ?? "(empty)"}`;
        };
        return ok(`Custom fields on VAN ${vanId}:\n${items.map(format).join("\n")}`);
      }

      case "ea_set_custom_field": {
        const vanId = args.vanId as number;
        const value = args.value as string;
        let fieldId = args.customFieldId as number | undefined;
        const fieldName = args.customFieldName as string | undefined;
        if (!fieldId) {
          if (!fieldName) return err("Provide customFieldId or customFieldName. Run ea_list_custom_fields to discover options.");
          const allFields = (await client.listCustomFields()).items ?? [];
          const needle = fieldName.trim().toLowerCase();
          const match = allFields.find((f) => (f.name ?? f.customFieldName ?? "").toLowerCase() === needle)
            ?? allFields.find((f) => (f.name ?? f.customFieldName ?? "").toLowerCase().includes(needle));
          if (!match) return err(`No custom field matched "${fieldName}". Run ea_list_custom_fields to see options.`);
          fieldId = match.customFieldId;
        }
        await client.setCustomField(vanId, fieldId, value);
        return ok(`Set custom field ${fieldId} on VAN ${vanId}.`);
      }

      case "ea_get_contact_full": {
        const vanId = args.vanId as number;
        const [person, notes, activistCodes, customFields] = await Promise.allSettled([
          client.getPerson(vanId),
          client.getNotes(vanId),
          client.listContactActivistCodes(vanId),
          client.getCustomFieldValues(vanId),
        ]);

        if (person.status === "rejected") return err(`Could not load VAN ${vanId}: ${person.reason}`);
        const p = person.value;

        const lines: string[] = [];
        const name = [p.prefix, p.firstName, p.middleName, p.lastName, p.suffix].filter(Boolean).join(" ") || "(no name)";
        lines.push(`=== ${name} | VAN ${vanId} ===`);
        if (p.nickname) lines.push(`  Nickname: ${p.nickname}`);
        if (p.employer) lines.push(`  Employer: ${p.employer}`);
        if (p.occupation) lines.push(`  Title: ${p.occupation}`);
        if (p.website) lines.push(`  Website: ${p.website}`);
        if (p.bio) lines.push(`  Bio: ${p.bio}`);

        if (p.emails?.length) {
          lines.push("\nEmails:");
          p.emails.forEach((e) => lines.push(`  ${e.email}${e.isPrimary ? " (primary)" : ""}`));
        }
        if (p.phones?.length) {
          lines.push("\nPhones:");
          p.phones.forEach((ph) => lines.push(`  ${ph.phoneNumber} (${ph.phoneType})${ph.isPrimary ? " (primary)" : ""}`));
        }
        if (p.addresses?.length) {
          lines.push("\nAddresses:");
          p.addresses.forEach((a) => {
            const addr = [a.addressLine1, a.city, a.stateOrProvince, a.zipOrPostalCode].filter(Boolean).join(", ");
            lines.push(`  ${addr}${a.isPrimary ? " (primary)" : ""}`);
          });
        }

        if (activistCodes.status === "fulfilled" && activistCodes.value.items?.length) {
          lines.push("\nActivist Codes:");
          activistCodes.value.items.forEach((c) => lines.push(`  ${c.activistCodeId}: ${c.activistCodeName}`));
        }

        if (customFields.status === "fulfilled" && customFields.value.items?.length) {
          const cfItems = customFields.value.items;
          let fieldDefs: Array<{ customFieldId: number; name?: string | null; customFieldName?: string | null }> = [];
          try { fieldDefs = (await client.listCustomFields()).items ?? []; } catch { /* non-fatal */ }
          const nameMap = new Map(fieldDefs.map((f) => [f.customFieldId, f.name ?? f.customFieldName ?? String(f.customFieldId)]));
          lines.push("\nCustom Fields:");
          cfItems.forEach((v) => {
            const label = nameMap.get(v.customFieldId) ?? String(v.customFieldId);
            lines.push(`  ${label}: ${v.assignedValue ?? "(empty)"}`);
          });
        }

        if (notes.status === "fulfilled" && notes.value.items?.length) {
          lines.push("\nRecent Notes:");
          notes.value.items.slice(0, 5).forEach((n) => lines.push(formatNote(n)));
        }

        return ok(lines.join("\n"));
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
