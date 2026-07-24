import { createApp, createRoute, z } from "@clawnify/app";
import freemailDomains from "free-email-domains";
import { query, get, run } from "./db.js";
import type { CredentialBinding } from "@clawnify/connections";
import { sendEmail, createMeeting, notifySlack, connectionStatus } from "./integrations.js";
import {
  listDefs,
  createDef,
  updateDef,
  deleteDef,
  coerceCustomValue,
  classifyCustomWrite,
  writableFieldKeys,
  isEntityType,
  type EntityType,
  type CustomFieldDef,
} from "./custom-fields.js";

// In production Clawnify injects the CREDENTIALS broker binding + CLAWNIFY_ORG_ID
// whenever clawnify.json declares `app.credentials`. SLACK_CHANNEL is an optional
// custom env var: when set (and Slack is connected), won deals auto-notify it.
type Env = {
  Bindings: {
    DB: D1Database;
    CREDENTIALS?: CredentialBinding;
    CLAWNIFY_ORG_ID?: string;
    SLACK_CHANNEL?: string;
  };
};

/** Split an array into fixed-size chunks. Used to keep bulk SQL within D1's
 * 100-bound-parameter limit (the same cap applies to the preview-tier Facet). */
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Append a row to the activity timeline. Never throws — logging is best-effort. */
async function logActivity(
  entity_type: string,
  entity_id: string,
  type: string,
  body: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  try {
    await run(
      "INSERT INTO activities (id, entity_type, entity_id, type, body, meta) VALUES (?, ?, ?, ?, ?, ?)",
      [crypto.randomUUID(), entity_type, entity_id, type, body, JSON.stringify(meta)],
    );
  } catch {
    /* timeline logging must never break the primary action */
  }
}

/**
 * Write custom-property values for one entity row. `custom` is the nested
 * object from the request body ({ key: value }); only keys with a matching def
 * are written, each coerced/validated for its type. Runs as a follow-up UPDATE
 * so the built-in INSERT/UPDATE paths stay untouched. Throws on enum violation.
 */
async function applyCustomValues(
  entity: EntityType,
  table: string,
  id: string,
  custom: Record<string, unknown> | undefined,
): Promise<void> {
  if (!custom || typeof custom !== "object") return;
  const defs = await listDefs(entity);
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [key, raw] of Object.entries(custom)) {
    const def = byKey.get(key);
    if (!def) continue; // ignore unknown keys — only defined properties are writable
    sets.push(`"${key.replace(/"/g, '""')}" = ?`);
    params.push(coerceCustomValue(raw, def));
  }
  if (sets.length === 0) return;
  params.push(id);
  await run(`UPDATE ${table} SET ${sets.join(", ")} WHERE id = ?`, params);
}

/** Reusable request-body field: the nested bag of custom-property values.
 *  Still accepted for back-compat, but custom keys may now also be sent flat at
 *  the top level (see resolveCustomWrite). */
const CustomValues = z.record(z.string(), z.any()).optional();

/** Merge a request body's flat top-level custom keys with its nested `custom`
 *  bag, then classify against the entity's registry. Both shapes are accepted
 *  (the bag wins on a key conflict); built-in base keys pass through untouched.
 *  Returns the writable custom values and any unknown keys the caller rejects. */
async function resolveCustomWrite(
  entity: EntityType,
  body: Record<string, unknown>,
): Promise<{ values: Record<string, unknown>; unknown: string[] }> {
  const candidates: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) if (k !== "custom") candidates[k] = v;
  const bag = body.custom;
  if (bag && typeof bag === "object") Object.assign(candidates, bag as Record<string, unknown>);
  return classifyCustomWrite(entity, candidates);
}

/** 422 body: a write named a field that is neither a base column nor a
 *  registered custom field — surfaced loudly instead of silently dropped. */
const UnknownFieldsSchema = z.object({
  error: z.string(),
  unknown_fields: z.array(z.string()),
  valid_fields: z.array(z.string()),
}).openapi("UnknownFields");

/** Build the 422 body when a write named unknown keys, or null when the write is
 *  clean. Returns the payload (not a Response) so each handler surfaces it via its
 *  own typed `c.json(body, 422)` — keeping OpenAPIHono's strict response inference. */
async function unknownFieldsError(
  entity: EntityType,
  unknown: string[],
): Promise<z.infer<typeof UnknownFieldsSchema> | null> {
  if (unknown.length === 0) return null;
  return {
    error: `Unknown field(s) for ${entity}: ${unknown.join(", ")}. Send a base field or a registered custom field, or define it first via POST /api/custom-fields.`,
    unknown_fields: unknown,
    valid_fields: await writableFieldKeys(entity),
  };
}

/** Quote a SQL identifier (custom-field keys are already regex-validated at
 *  def creation, but quote defensively — same as applyCustomValues). */
const quoteIdent = (k: string) => `"${k.replace(/"/g, '""')}"`;

/** Lenient coercion for bulk import: an invalid cell (bad enum, unparseable
 *  number) becomes null rather than aborting the whole import batch. */
function coerceForImport(value: unknown, def: CustomFieldDef): string | number | null {
  try {
    const v = coerceCustomValue(value, def);
    return typeof v === "number" && Number.isNaN(v) ? null : v;
  } catch {
    return null;
  }
}

/** The custom columns to write for an import: defs whose key is present and
 *  non-empty in at least one row's `custom` bag. Keeps the bulk INSERT narrow. */
async function resolveImportCustomColumns(
  entity: EntityType,
  rows: Array<{ custom?: Record<string, unknown> }>,
): Promise<{ keys: string[]; defByKey: Map<string, CustomFieldDef> }> {
  const defByKey = new Map((await listDefs(entity)).map((d) => [d.key, d]));
  const present = new Set<string>();
  for (const r of rows) {
    if (!r.custom || typeof r.custom !== "object") continue;
    for (const [k, v] of Object.entries(r.custom)) {
      if (defByKey.has(k) && v !== null && v !== undefined && v !== "") present.add(k);
    }
  }
  return { keys: [...present], defByKey };
}

// createApp bakes in the standard skeleton: OpenAPIHono construction, the
// per-request D1/Storage init middleware, and API discovery (GET
// /api/openapi.json + GET /llms.txt from the live routes). App code below is
// just routes + business logic.
const app = createApp<Env>({
  title: "Dealflow",
  version: "1.0.0",
  description: "A dealflow CRM for investors: startups, people, a VC pipeline, and a warm-intro relationship graph.",
});

// ── Shared Schemas ─────────────────────────────────────────────────

const ErrorSchema = z.object({ error: z.string() }).openapi("Error");
const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

const CompanySchema = z.object({
  id: z.string(),
  name: z.string(),
  domain: z.string(),
  industry: z.string(),
  location: z.string(),
  phone: z.string(),
  email: z.string(),
  notes: z.string(),
  contact_count: z.number().int().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Company");

const ContactSchema = z.object({
  id: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  email: z.string(),
  phone: z.string(),
  company_id: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  company_name: z.string().nullable().optional(),
  company_domain: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Contact");

const DealSchema = z.object({
  id: z.string(),
  name: z.string(),
  contact_id: z.string().nullable(),
  value: z.number().openapi({ description: "Check size under consideration (USD)" }),
  stage: z.string(),
  round: z.string().openapi({ description: "Round being raised (pre-seed, seed, series-a, …)" }),
  valuation: z.number().openapi({ description: "Round valuation (USD), 0 if unknown" }),
  source_contact_id: z.string().nullable().openapi({ description: "Contact who referred this deal" }),
  pass_reason: z.string().openapi({ description: "Why the firm passed (set when stage=passed)" }),
  close_date: z.string(),
  notes: z.string(),
  contact_first_name: z.string().nullable().optional(),
  contact_last_name: z.string().nullable().optional(),
  company_name: z.string().nullable().optional(),
  company_domain: z.string().nullable().optional(),
  source_first_name: z.string().nullable().optional(),
  source_last_name: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).openapi("Deal");

const IdParam = z.object({ id: z.string().openapi({ description: "Resource ID (integer)" }) });

const PaginationQuery = z.object({
  page: z.string().optional().openapi({ description: "Page number (default: 1)" }),
  limit: z.string().optional().openapi({ description: "Items per page (default: 25, max: 100)" }),
  sort: z.string().optional().openapi({ description: "Column to sort by (any real column, incl. custom fields)" }),
  order: z.enum(["asc", "desc"]).optional().openapi({ description: "Sort direction (default: desc)" }),
  search: z.string().optional().openapi({ description: "Search term" }),
  filters: z.string().optional().openapi({ description: 'JSON array of {field, op, value} — op ∈ contains|is|is_not|is_empty|is_not_empty|gt|lt' }),
});

/** Real column names of a table (from sqlite). Used to validate sort/filter
 *  fields against actual columns — the safe allowlist for built-ins + custom. */
async function tableColumns(table: string): Promise<Set<string>> {
  const rows = await query<{ name: string }>(`PRAGMA table_info(${table})`);
  return new Set(rows.map((r) => r.name));
}

const qid = (col: string) => `"${col.replace(/"/g, '""')}"`;

interface Filter { field: string; op: string; value?: string }

/** Build safe WHERE clauses from a JSON filter list. Fields are validated
 *  against `cols` (real columns), so identifiers are never user-controlled;
 *  values are always parameterised. */
function buildFilters(cols: Set<string>, raw: string | undefined, prefix = ""): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let filters: Filter[] = [];
  try { const a = JSON.parse(raw || "[]"); if (Array.isArray(a)) filters = a; } catch { /* ignore */ }
  for (const f of filters) {
    if (!f || typeof f.field !== "string" || !cols.has(f.field)) continue;
    const col = `${prefix}${qid(f.field)}`;
    const v = f.value ?? "";
    switch (f.op) {
      case "contains": clauses.push(`${col} LIKE ?`); params.push(`%${v}%`); break;
      case "is": clauses.push(`${col} = ?`); params.push(v); break;
      case "is_not": clauses.push(`(${col} IS NULL OR ${col} != ?)`); params.push(v); break;
      case "is_empty": clauses.push(`(${col} IS NULL OR ${col} = '')`); break;
      case "is_not_empty": clauses.push(`(${col} IS NOT NULL AND ${col} != '')`); break;
      case "gt": clauses.push(`${col} > ?`); params.push(Number(v)); break;
      case "lt": clauses.push(`${col} < ?`); params.push(Number(v)); break;
      default: break;
    }
  }
  return { clauses, params };
}

// ── Stats ──────────────────────────────────────────────────────────

const getStats = createRoute({
  method: "get",
  path: "/api/stats",
  tags: ["Stats"],
  summary: "Get dashboard statistics",
  responses: {
    200: {
      description: "Dashboard stats",
      content: { "application/json": { schema: z.object({
        contacts: z.number().int(),
        companies: z.number().int(),
        deals: z.number().int(),
        dealValue: z.number(),
      }) } },
    },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getStats, async (c) => {
  try {
    const contacts = await get<{ count: number }>("SELECT COUNT(*) as count FROM contacts");
    const companies = await get<{ count: number }>("SELECT COUNT(*) as count FROM companies");
    const deals = await get<{ count: number }>("SELECT COUNT(*) as count FROM deals");
    const dealValue = await get<{ total: number }>("SELECT COALESCE(SUM(value), 0) as total FROM deals WHERE stage NOT IN ('passed')");
    return c.json({
      contacts: contacts?.count || 0,
      companies: companies?.count || 0,
      deals: deals?.count || 0,
      dealValue: dealValue?.total || 0,
    }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Companies ──────────────────────────────────────────────────────

const listCompanies = createRoute({
  method: "get",
  path: "/api/companies",
  tags: ["Companies"],
  summary: "List companies with pagination, search, and filtering",
  request: {
    query: PaginationQuery.extend({
      industry: z.string().optional().openapi({ description: "Filter by industry" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated companies",
      content: { "application/json": { schema: z.object({
        companies: z.array(CompanySchema),
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
      }) } },
    },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listCompanies, async (c) => {
  try {
    const q = c.req.valid("query");
    const page = Math.max(1, parseInt(q.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10)));
    const offset = (page - 1) * limit;
    const search = (q.search || "").trim();
    const industry = (q.industry || "").trim();

    const cols = await tableColumns("companies");
    let sortCol = q.sort || "id";
    if (!cols.has(sortCol)) sortCol = "id";
    let order = (q.order || "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";

    const where: string[] = [];
    const params: unknown[] = [];

    if (search) {
      where.push("(name LIKE ? OR domain LIKE ? OR email LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (industry) {
      where.push("industry = ?");
      params.push(industry);
    }
    const flt = buildFilters(cols, q.filters);
    where.push(...flt.clauses);
    params.push(...flt.params);

    const whereSQL = where.length ? " WHERE " + where.join(" AND ") : "";

    const countResult = await get<{ total: number }>(
      "SELECT COUNT(*) as total FROM companies" + whereSQL,
      [...params],
    );
    const total = countResult?.total || 0;

    const rows = await query(
      `SELECT c.*, (SELECT COUNT(*) FROM contacts WHERE company_id = c.id) as contact_count
       FROM companies c${whereSQL} ORDER BY c.${qid(sortCol)} ${order}, c.id LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return c.json({ companies: rows, total, page, limit }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const createCompany = createRoute({
  method: "post",
  path: "/api/companies",
  tags: ["Companies"],
  summary: "Create a new company",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        name: z.string().min(1),
        domain: z.string().optional(),
        industry: z.string().optional(),
        location: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        notes: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    201: { description: "Created company", content: { "application/json": { schema: z.object({ company: CompanySchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createCompany, async (c) => {
  try {
    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("company", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("company", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const name = body.name.trim();
    if (!name) return c.json({ error: "Name is required" }, 400);

    const id = crypto.randomUUID();
    await run(
      "INSERT INTO companies (id, name, domain, industry, location, phone, email, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, name, (body.domain || "").trim(), (body.industry || "").trim(), (body.location || "").trim(), (body.phone || "").trim(), (body.email || "").trim(), (body.notes || "").trim()],
    );

    await applyCustomValues("company", "companies", id, customValues);

    const inserted = await get("SELECT * FROM companies WHERE id = ?", [id]);
    return c.json({ company: inserted }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const updateCompany = createRoute({
  method: "put",
  path: "/api/companies/{id}",
  tags: ["Companies"],
  summary: "Update a company",
  request: {
    params: IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        domain: z.string().optional(),
        industry: z.string().optional(),
        location: z.string().optional(),
        phone: z.string().optional(),
        email: z.string().optional(),
        notes: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    200: { description: "Updated company", content: { "application/json": { schema: z.object({ company: CompanySchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateCompany, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("company", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("company", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const fields: string[] = [];
    const params: unknown[] = [];

    for (const key of ["name", "domain", "industry", "location", "phone", "email", "notes"] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(typeof body[key] === "string" ? body[key].trim() : body[key]);
      }
    }

    const hasCustom = Object.keys(customValues).length > 0;
    if (fields.length === 0 && !hasCustom) return c.json({ error: "No fields to update" }, 400);

    const exists = await get("SELECT id FROM companies WHERE id = ?", [id]);
    if (!exists) return c.json({ error: "Company not found" }, 404);

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      params.push(id);
      await run("UPDATE companies SET " + fields.join(", ") + " WHERE id = ?", params);
    }
    await applyCustomValues("company", "companies", id, customValues);

    const updated = await get("SELECT * FROM companies WHERE id = ?", [id]);
    return c.json({ company: updated }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const deleteCompany = createRoute({
  method: "delete",
  path: "/api/companies/{id}",
  tags: ["Companies"],
  summary: "Delete a company",
  request: { params: IdParam },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteCompany, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const result = await run("DELETE FROM companies WHERE id = ?", [id]);
    if (result.changes === 0) return c.json({ error: "Company not found" }, 404);
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Contacts ───────────────────────────────────────────────────────

const listContacts = createRoute({
  method: "get",
  path: "/api/contacts",
  tags: ["Contacts"],
  summary: "List contacts with pagination, search, and filtering",
  request: {
    query: PaginationQuery.extend({
      status: z.string().optional().openapi({ description: "Filter by type (founder, investor, lp, operator, other)" }),
      company_id: z.string().optional().openapi({ description: "Filter by company ID" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated contacts",
      content: { "application/json": { schema: z.object({
        contacts: z.array(ContactSchema),
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
      }) } },
    },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listContacts, async (c) => {
  try {
    const q = c.req.valid("query");
    const page = Math.max(1, parseInt(q.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10)));
    const offset = (page - 1) * limit;
    const search = (q.search || "").trim();
    const status = (q.status || "").trim();
    const companyId = q.company_id || "";

    const cols = await tableColumns("contacts");
    let sortCol = q.sort || "id";
    if (!cols.has(sortCol)) sortCol = "id";
    let order = (q.order || "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";

    const where: string[] = [];
    const params: unknown[] = [];

    if (search) {
      // Match the contact's own fields OR their company name, so searching a
      // company surfaces its contacts (both queries LEFT JOIN companies as `co`).
      where.push("(ct.first_name LIKE ? OR ct.last_name LIKE ? OR ct.email LIKE ? OR ct.title LIKE ? OR co.name LIKE ?)");
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (status) {
      where.push("ct.status = ?");
      params.push(status);
    }
    if (companyId) {
      where.push("ct.company_id = ?");
      params.push(companyId);
    }
    const flt = buildFilters(cols, q.filters, "ct.");
    where.push(...flt.clauses);
    params.push(...flt.params);

    const whereSQL = where.length ? " WHERE " + where.join(" AND ") : "";

    const countResult = await get<{ total: number }>(
      "SELECT COUNT(*) as total FROM contacts ct LEFT JOIN companies co ON ct.company_id = co.id" + whereSQL,
      [...params],
    );
    const total = countResult?.total || 0;

    const rows = await query(
      `SELECT ct.*, co.name as company_name, co.domain as company_domain
       FROM contacts ct
       LEFT JOIN companies co ON ct.company_id = co.id
       ${whereSQL}
       ORDER BY ct.${qid(sortCol)} ${order}, ct.id
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return c.json({ contacts: rows, total, page, limit }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const createContact = createRoute({
  method: "post",
  path: "/api/contacts",
  tags: ["Contacts"],
  summary: "Create a new contact",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        first_name: z.string().min(1),
        last_name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        company_id: z.string().nullable().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    201: { description: "Created contact", content: { "application/json": { schema: z.object({ contact: ContactSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createContact, async (c) => {
  try {
    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("contact", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("contact", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const firstName = body.first_name.trim();
    if (!firstName) return c.json({ error: "First name is required" }, 400);

    // Link to the chosen company, or infer one from the work-email domain
    // (skips free providers) so a contact never lands orphaned when its email
    // clearly belongs to a company.
    let companyId = body.company_id ? String(body.company_id) : null;
    if (!companyId && body.email) {
      const dom = workEmailDomain(String(body.email));
      if (dom) companyId = await findOrCreateCompanyByDomain(dom);
    }

    const id = crypto.randomUUID();
    await run(
      "INSERT INTO contacts (id, first_name, last_name, email, phone, company_id, title, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [id, firstName, (body.last_name || "").trim(), (body.email || "").trim(), (body.phone || "").trim(), companyId, (body.title || "").trim(), (body.status || "founder").trim()],
    );

    await applyCustomValues("contact", "contacts", id, customValues);

    const inserted = await get(
      `SELECT ct.*, co.name as company_name, co.domain as company_domain
       FROM contacts ct LEFT JOIN companies co ON ct.company_id = co.id
       WHERE ct.id = ?`,
      [id],
    );
    return c.json({ contact: inserted }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const updateContact = createRoute({
  method: "put",
  path: "/api/contacts/{id}",
  tags: ["Contacts"],
  summary: "Update a contact",
  request: {
    params: IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        email: z.string().optional(),
        phone: z.string().optional(),
        company_id: z.string().nullable().optional(),
        title: z.string().optional(),
        status: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    200: { description: "Updated contact", content: { "application/json": { schema: z.object({ contact: ContactSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateContact, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("contact", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("contact", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const fields: string[] = [];
    const params: unknown[] = [];

    for (const key of ["first_name", "last_name", "email", "phone", "title", "status"] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(typeof body[key] === "string" ? body[key].trim() : body[key]);
      }
    }
    if (body.company_id !== undefined) {
      fields.push("company_id = ?");
      params.push(body.company_id ? String(body.company_id) : null);
    }

    const hasCustom = Object.keys(customValues).length > 0;
    if (fields.length === 0 && !hasCustom) return c.json({ error: "No fields to update" }, 400);

    const exists = await get("SELECT id FROM contacts WHERE id = ?", [id]);
    if (!exists) return c.json({ error: "Contact not found" }, 404);

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      params.push(id);
      await run("UPDATE contacts SET " + fields.join(", ") + " WHERE id = ?", params);
    }
    await applyCustomValues("contact", "contacts", id, customValues);

    const updated = await get(
      `SELECT ct.*, co.name as company_name, co.domain as company_domain
       FROM contacts ct LEFT JOIN companies co ON ct.company_id = co.id
       WHERE ct.id = ?`,
      [id],
    );
    return c.json({ contact: updated }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const deleteContact = createRoute({
  method: "delete",
  path: "/api/contacts/{id}",
  tags: ["Contacts"],
  summary: "Delete a contact",
  request: { params: IdParam },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteContact, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const result = await run("DELETE FROM contacts WHERE id = ?", [id]);
    if (result.changes === 0) return c.json({ error: "Contact not found" }, 404);
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Deals ──────────────────────────────────────────────────────────

const getDealsBoard = createRoute({
  method: "get",
  path: "/api/deals/board",
  tags: ["Deals"],
  summary: "Get all deals for the pipeline board view",
  responses: {
    200: { description: "All deals with contact/company info", content: { "application/json": { schema: z.object({ deals: z.array(DealSchema) }) } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(getDealsBoard, async (c) => {
  try {
    const rows = await query(
      `SELECT d.*,
              ct.first_name as contact_first_name, ct.last_name as contact_last_name,
              co.name as company_name, co.domain as company_domain,
              src.first_name as source_first_name, src.last_name as source_last_name
       FROM deals d
       LEFT JOIN contacts ct ON d.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id
       LEFT JOIN contacts src ON d.source_contact_id = src.id
       ORDER BY d.created_at ASC`,
    );
    return c.json({ deals: rows }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const listDeals = createRoute({
  method: "get",
  path: "/api/deals",
  tags: ["Deals"],
  summary: "List deals with pagination, search, and filtering",
  request: {
    query: PaginationQuery.extend({
      stage: z.string().optional().openapi({ description: "Filter by stage (sourced, screening, partner_meeting, diligence, term_sheet, invested, passed)" }),
      contact_id: z.string().optional().openapi({ description: "Filter by contact ID" }),
    }),
  },
  responses: {
    200: {
      description: "Paginated deals",
      content: { "application/json": { schema: z.object({
        deals: z.array(DealSchema),
        total: z.number().int(),
        page: z.number().int(),
        limit: z.number().int(),
        totalValue: z.number(),
      }) } },
    },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listDeals, async (c) => {
  try {
    const q = c.req.valid("query");
    const page = Math.max(1, parseInt(q.page || "1", 10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit || "25", 10)));
    const offset = (page - 1) * limit;
    const search = (q.search || "").trim();
    const stage = (q.stage || "").trim();
    const contactId = q.contact_id || "";

    let sortCol = q.sort || "id";
    if (!["id", "name", "value", "stage", "round", "valuation", "close_date", "created_at"].includes(sortCol)) sortCol = "id";
    let order = (q.order || "desc").toLowerCase();
    if (order !== "asc" && order !== "desc") order = "desc";

    const where: string[] = [];
    const params: unknown[] = [];

    if (search) {
      where.push("(d.name LIKE ? OR d.notes LIKE ?)");
      params.push(`%${search}%`, `%${search}%`);
    }
    if (stage) {
      where.push("d.stage = ?");
      params.push(stage);
    }
    if (contactId) {
      where.push("d.contact_id = ?");
      params.push(contactId);
    }

    const whereSQL = where.length ? " WHERE " + where.join(" AND ") : "";

    const countResult = await get<{ total: number }>(
      "SELECT COUNT(*) as total FROM deals d" + whereSQL,
      [...params],
    );
    const total = countResult?.total || 0;

    const agg = await get<{ total_value: number }>(
      "SELECT COALESCE(SUM(d.value), 0) as total_value FROM deals d" + whereSQL,
      [...params],
    );

    const rows = await query(
      `SELECT d.*,
              ct.first_name as contact_first_name, ct.last_name as contact_last_name,
              co.name as company_name, co.domain as company_domain,
              src.first_name as source_first_name, src.last_name as source_last_name
       FROM deals d
       LEFT JOIN contacts ct ON d.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id
       LEFT JOIN contacts src ON d.source_contact_id = src.id
       ${whereSQL}
       ORDER BY d.${sortCol} ${order}, d.id
       LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );

    return c.json({ deals: rows, total, page, limit, totalValue: agg?.total_value || 0 }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const createDeal = createRoute({
  method: "post",
  path: "/api/deals",
  tags: ["Deals"],
  summary: "Create a new deal",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        name: z.string().min(1),
        contact_id: z.string().nullable().optional(),
        value: z.union([z.number(), z.string()]).optional().openapi({ description: "Check size (USD)" }),
        stage: z.string().optional(),
        round: z.string().optional(),
        valuation: z.union([z.number(), z.string()]).optional(),
        source_contact_id: z.string().nullable().optional(),
        pass_reason: z.string().optional(),
        close_date: z.string().optional(),
        notes: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    201: { description: "Created deal", content: { "application/json": { schema: z.object({ deal: DealSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createDeal, async (c) => {
  try {
    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("deal", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("deal", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const name = body.name.trim();
    if (!name) return c.json({ error: "Name is required" }, 400);

    const contactId = body.contact_id ? String(body.contact_id) : null;
    const sourceContactId = body.source_contact_id ? String(body.source_contact_id) : null;
    const value = parseFloat(String(body.value)) || 0;
    const valuation = parseFloat(String(body.valuation)) || 0;

    const id = crypto.randomUUID();
    await run(
      "INSERT INTO deals (id, name, contact_id, value, stage, round, valuation, source_contact_id, pass_reason, close_date, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [id, name, contactId, value, (body.stage || "sourced").trim(), (body.round || "").trim(), valuation, sourceContactId, (body.pass_reason || "").trim(), (body.close_date || "").trim(), (body.notes || "").trim()],
    );

    await applyCustomValues("deal", "deals", id, customValues);

    const inserted = await get(
      `SELECT d.*, ct.first_name as contact_first_name, ct.last_name as contact_last_name,
              co.name as company_name, co.domain as company_domain,
              src.first_name as source_first_name, src.last_name as source_last_name
       FROM deals d
       LEFT JOIN contacts ct ON d.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id
       LEFT JOIN contacts src ON d.source_contact_id = src.id
       WHERE d.id = ?`,
      [id],
    );
    return c.json({ deal: inserted }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const updateDeal = createRoute({
  method: "put",
  path: "/api/deals/{id}",
  tags: ["Deals"],
  summary: "Update a deal",
  request: {
    params: IdParam,
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        name: z.string().optional(),
        contact_id: z.string().nullable().optional(),
        value: z.union([z.number(), z.string()]).optional().openapi({ description: "Check size (USD)" }),
        stage: z.string().optional(),
        round: z.string().optional(),
        valuation: z.union([z.number(), z.string()]).optional(),
        source_contact_id: z.string().nullable().optional(),
        pass_reason: z.string().optional(),
        close_date: z.string().optional(),
        notes: z.string().optional(),
        custom: CustomValues,
      }).passthrough() } },
    },
  },
  responses: {
    200: { description: "Updated deal", content: { "application/json": { schema: z.object({ deal: DealSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    422: { description: "Unknown field(s)", content: { "application/json": { schema: UnknownFieldsSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(updateDeal, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const body = c.req.valid("json");
    const { values: customValues, unknown } = await resolveCustomWrite("deal", body as unknown as Record<string, unknown>);
    const unknownErr = await unknownFieldsError("deal", unknown);
    if (unknownErr) return c.json(unknownErr, 422);
    const fields: string[] = [];
    const params: unknown[] = [];

    for (const key of ["name", "stage", "round", "pass_reason", "close_date", "notes"] as const) {
      if (body[key] !== undefined) {
        fields.push(`${key} = ?`);
        params.push(typeof body[key] === "string" ? body[key].trim() : body[key]);
      }
    }
    if (body.value !== undefined) {
      fields.push("value = ?");
      params.push(parseFloat(String(body.value)) || 0);
    }
    if (body.valuation !== undefined) {
      fields.push("valuation = ?");
      params.push(parseFloat(String(body.valuation)) || 0);
    }
    if (body.contact_id !== undefined) {
      fields.push("contact_id = ?");
      params.push(body.contact_id ? String(body.contact_id) : null);
    }
    if (body.source_contact_id !== undefined) {
      fields.push("source_contact_id = ?");
      params.push(body.source_contact_id ? String(body.source_contact_id) : null);
    }

    const hasCustom = Object.keys(customValues).length > 0;
    if (fields.length === 0 && !hasCustom) return c.json({ error: "No fields to update" }, 400);

    const exists = await get("SELECT id FROM deals WHERE id = ?", [id]);
    if (!exists) return c.json({ error: "Deal not found" }, 404);

    if (fields.length > 0) {
      fields.push("updated_at = datetime('now')");
      params.push(id);
      await run("UPDATE deals SET " + fields.join(", ") + " WHERE id = ?", params);
    }
    await applyCustomValues("deal", "deals", id, customValues);

    const updated = await get<Record<string, unknown>>(
      `SELECT d.*, ct.first_name as contact_first_name, ct.last_name as contact_last_name,
              co.name as company_name, co.domain as company_domain,
              src.first_name as source_first_name, src.last_name as source_last_name
       FROM deals d
       LEFT JOIN contacts ct ON d.contact_id = ct.id
       LEFT JOIN companies co ON ct.company_id = co.id
       LEFT JOIN contacts src ON d.source_contact_id = src.id
       WHERE d.id = ?`,
      [id],
    );

    // Deal just marked invested → log it and notify Slack (best-effort, never
    // blocks the update). Fires only when this request set stage='invested'.
    if (body.stage === "invested" && updated) {
      const value = Number(updated.value) || 0;
      await logActivity("deal", id, "stage_change", `Investment closed`, { stage: "invested", value });
      const channel = c.env.SLACK_CHANNEL?.trim();
      if (channel) {
        const contact = [updated.contact_first_name, updated.contact_last_name].filter(Boolean).join(" ");
        const text = `🎉 *Investment closed:* ${updated.name} — $${value.toLocaleString()}${contact ? ` (${contact})` : ""}`;
        try {
          await notifySlack(c.env, { channel, text });
          await logActivity("deal", id, "slack", `Notified #${channel} of the investment`, { channel });
        } catch {
          /* Slack not connected / channel missing — the investment is still recorded */
        }
      }
    }
    // Deal just passed → record the decision (and its reason) on the timeline,
    // so "why did we pass?" is answerable months later.
    if (body.stage === "passed" && updated) {
      const reason = String(updated.pass_reason || "").trim();
      await logActivity("deal", id, "stage_change", reason ? `Passed — ${reason}` : "Passed", { stage: "passed", pass_reason: reason });
    }
    return c.json({ deal: updated }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const deleteDeal = createRoute({
  method: "delete",
  path: "/api/deals/{id}",
  tags: ["Deals"],
  summary: "Delete a deal",
  request: { params: IdParam },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: OkSchema } } },
    400: { description: "Invalid ID", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteDeal, async (c) => {
  try {
    const { id } = c.req.valid("param");
    if (!id) return c.json({ error: "Invalid ID" }, 400);

    const result = await run("DELETE FROM deals WHERE id = ?", [id]);
    if (result.changes === 0) return c.json({ error: "Deal not found" }, 404);
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Relationships (the warm-intro graph) ───────────────────────────
// Directed edges between contacts: contact_id knows knows_contact_id. The
// agent (or user) records who knows whom; intro-paths answers "who can get
// me into <company>?" from those edges.

const RelationshipSchema = z.object({
  id: z.string(),
  contact_id: z.string(),
  knows_contact_id: z.string(),
  strength: z.string().openapi({ description: "strong | medium | weak" }),
  context: z.string().openapi({ description: "How they know each other" }),
  created_at: z.string(),
  updated_at: z.string(),
  contact_name: z.string().optional(),
  knows_name: z.string().optional(),
  knows_title: z.string().nullable().optional(),
  knows_company_name: z.string().nullable().optional(),
}).openapi("Relationship");

const RELATIONSHIP_STRENGTHS = ["strong", "medium", "weak"];

/** Row shape returned by the relationship queries — matches RelationshipSchema
 *  so the OpenAPIHono typed responses line up without casts. */
type RelationshipRow = z.infer<typeof RelationshipSchema>;

const listContactRelationships = createRoute({
  method: "get",
  path: "/api/contacts/{id}/relationships",
  tags: ["Network"],
  summary: "List a contact's relationships (both directions: who they know, who knows them)",
  request: { params: IdParam },
  responses: {
    200: {
      description: "The contact's edges in the relationship graph",
      content: { "application/json": { schema: z.object({
        knows: z.array(RelationshipSchema),
        known_by: z.array(RelationshipSchema),
      }) } },
    },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(listContactRelationships, async (c) => {
  try {
    const { id } = c.req.valid("param");
    const exists = await get("SELECT id FROM contacts WHERE id = ?", [id]);
    if (!exists) return c.json({ error: "Contact not found" }, 404);

    const knows = await query<RelationshipRow>(
      `SELECT r.*, (k.first_name || ' ' || k.last_name) as knows_name, k.title as knows_title, co.name as knows_company_name
       FROM relationships r
       JOIN contacts k ON r.knows_contact_id = k.id
       LEFT JOIN companies co ON k.company_id = co.id
       WHERE r.contact_id = ? ORDER BY r.updated_at DESC LIMIT 100`,
      [id],
    );
    const known_by = await query<RelationshipRow>(
      `SELECT r.*, (k.first_name || ' ' || k.last_name) as contact_name
       FROM relationships r
       JOIN contacts k ON r.contact_id = k.id
       WHERE r.knows_contact_id = ? ORDER BY r.updated_at DESC LIMIT 100`,
      [id],
    );
    return c.json({ knows, known_by }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const createRelationship = createRoute({
  method: "post",
  path: "/api/relationships",
  tags: ["Network"],
  summary: "Record that one contact knows another (upserts on the pair)",
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: z.object({
        contact_id: z.string().min(1),
        knows_contact_id: z.string().min(1),
        strength: z.string().optional().openapi({ description: "strong | medium | weak (default medium)" }),
        context: z.string().optional().openapi({ description: "How they know each other" }),
        mutual: z.boolean().optional().openapi({ description: "Also record the reverse edge (default false)" }),
      }) } },
    },
  },
  responses: {
    201: { description: "Recorded relationship", content: { "application/json": { schema: z.object({ relationship: RelationshipSchema }) } } },
    400: { description: "Validation error", content: { "application/json": { schema: ErrorSchema } } },
    404: { description: "Contact not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(createRelationship, async (c) => {
  try {
    const body = c.req.valid("json");
    const contactId = body.contact_id.trim();
    const knowsId = body.knows_contact_id.trim();
    if (contactId === knowsId) return c.json({ error: "A contact cannot know themselves" }, 400);
    const strength = RELATIONSHIP_STRENGTHS.includes((body.strength || "").trim()) ? (body.strength as string).trim() : "medium";
    const context = (body.context || "").trim();

    const a = await get("SELECT id FROM contacts WHERE id = ?", [contactId]);
    const b = await get("SELECT id FROM contacts WHERE id = ?", [knowsId]);
    if (!a || !b) return c.json({ error: "Contact not found" }, 404);

    const upsert = (cid: string, kid: string) =>
      run(
        `INSERT INTO relationships (id, contact_id, knows_contact_id, strength, context)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(contact_id, knows_contact_id)
         DO UPDATE SET strength = excluded.strength,
                       context = CASE WHEN excluded.context != '' THEN excluded.context ELSE relationships.context END,
                       updated_at = datetime('now')`,
        [crypto.randomUUID(), cid, kid, strength, context],
      );
    await upsert(contactId, knowsId);
    if (body.mutual === true) await upsert(knowsId, contactId);

    const inserted = await get<RelationshipRow>(
      `SELECT r.*, (k.first_name || ' ' || k.last_name) as knows_name, k.title as knows_title, co.name as knows_company_name
       FROM relationships r
       JOIN contacts k ON r.knows_contact_id = k.id
       LEFT JOIN companies co ON k.company_id = co.id
       WHERE r.contact_id = ? AND r.knows_contact_id = ?`,
      [contactId, knowsId],
    );
    if (!inserted) return c.json({ error: "Failed to record relationship" }, 500);
    return c.json({ relationship: inserted }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const deleteRelationship = createRoute({
  method: "delete",
  path: "/api/relationships/{id}",
  tags: ["Network"],
  summary: "Delete a relationship edge",
  request: { params: IdParam },
  responses: {
    200: { description: "Success", content: { "application/json": { schema: OkSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(deleteRelationship, async (c) => {
  try {
    const { id } = c.req.valid("param");
    const result = await run("DELETE FROM relationships WHERE id = ?", [id]);
    if (result.changes === 0) return c.json({ error: "Relationship not found" }, 404);
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

const introPaths = createRoute({
  method: "get",
  path: "/api/network/intro-paths",
  tags: ["Network"],
  summary: "Warm-intro paths: who in the network can introduce you to a company or contact",
  request: {
    query: z.object({
      company_id: z.string().optional().openapi({ description: "Target company — finds paths to each of its contacts" }),
      contact_id: z.string().optional().openapi({ description: "Target contact — finds who knows them" }),
    }),
  },
  responses: {
    200: {
      description: "Paths grouped by target contact, strongest first",
      content: { "application/json": { schema: z.object({
        paths: z.array(z.object({
          target_contact_id: z.string(),
          target_name: z.string(),
          target_title: z.string().nullable(),
          via_contact_id: z.string(),
          via_name: z.string(),
          via_status: z.string().openapi({ description: "The introducer's type (founder, investor, lp, operator, other)" }),
          strength: z.string(),
          context: z.string(),
        })),
      }) } },
    },
    400: { description: "Missing target", content: { "application/json": { schema: ErrorSchema } } },
    500: { description: "Server error", content: { "application/json": { schema: ErrorSchema } } },
  },
});

app.openapi(introPaths, async (c) => {
  try {
    const q = c.req.valid("query");
    const companyId = (q.company_id || "").trim();
    const contactId = (q.contact_id || "").trim();
    if (!companyId && !contactId) return c.json({ error: "company_id or contact_id is required" }, 400);

    const where = companyId ? "t.company_id = ?" : "t.id = ?";
    const param = companyId || contactId;
    const paths = await query<{
      target_contact_id: string; target_name: string; target_title: string | null;
      via_contact_id: string; via_name: string; via_status: string;
      strength: string; context: string;
    }>(
      `SELECT t.id as target_contact_id, (t.first_name || ' ' || t.last_name) as target_name, t.title as target_title,
              v.id as via_contact_id, (v.first_name || ' ' || v.last_name) as via_name, v.status as via_status,
              r.strength, r.context
       FROM contacts t
       JOIN relationships r ON r.knows_contact_id = t.id
       JOIN contacts v ON r.contact_id = v.id
       WHERE ${where}
       ORDER BY CASE r.strength WHEN 'strong' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, r.updated_at DESC
       LIMIT 50`,
      [param],
    );
    return c.json({ paths }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Activity timeline ──────────────────────────────────────────────
// Plain Hono handlers (not createRoute) to keep the integration surface
// compact; validation is done inline in the same defensive style as above.

const ENTITY_TYPES = ["contact", "company", "deal"];

app.get("/api/activities", async (c) => {
  try {
    const entity_type = (c.req.query("entity_type") || "").trim();
    const entity_id = (c.req.query("entity_id") || "").trim();
    if (!ENTITY_TYPES.includes(entity_type) || !entity_id) {
      return c.json({ error: "entity_type and entity_id are required" }, 400);
    }
    const activities = await query(
      "SELECT * FROM activities WHERE entity_type = ? AND entity_id = ? ORDER BY created_at DESC, id DESC",
      [entity_type, entity_id],
    );
    return c.json({ activities }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

app.post("/api/activities", async (c) => {
  try {
    const body = await c.req.json<{ entity_type?: string; entity_id?: string; type?: string; body?: string }>();
    const entity_type = (body.entity_type || "").trim();
    const entity_id = (body.entity_id || "").trim();
    if (!ENTITY_TYPES.includes(entity_type) || !entity_id) {
      return c.json({ error: "entity_type and entity_id are required" }, 400);
    }
    const text = (body.body || "").trim();
    if (!text) return c.json({ error: "Note body is required" }, 400);
    await logActivity(entity_type, entity_id, (body.type || "note").trim(), text);
    return c.json({ ok: true }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Integrations (Clawnify connections) ────────────────────────────

app.get("/api/integrations/status", async (c) => {
  try {
    return c.json(await connectionStatus(c.env), 200);
  } catch {
    return c.json({ email: false, meeting: false, slack: false }, 200);
  }
});

// Email a contact via connected Gmail, then log it on the contact's timeline.
app.post("/api/integrations/email", async (c) => {
  try {
    const body = await c.req.json<{ contact_id?: string; subject?: string; body?: string }>();
    const contactId = (body.contact_id || "").trim();
    const subject = (body.subject || "").trim();
    const text = (body.body || "").trim();
    if (!contactId) return c.json({ error: "contact_id is required" }, 400);
    if (!subject && !text) return c.json({ error: "A subject or body is required" }, 400);

    const contact = await get<{ email: string; first_name: string; last_name: string }>(
      "SELECT email, first_name, last_name FROM contacts WHERE id = ?",
      [contactId],
    );
    if (!contact) return c.json({ error: "Contact not found" }, 404);
    if (!contact.email) return c.json({ error: "Contact has no email address" }, 400);

    await sendEmail(c.env, { to: contact.email, subject, body: text });
    await logActivity("contact", contactId, "email", subject || "(no subject)", { to: contact.email });
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// Schedule a Google Calendar meeting with a contact, then log it.
app.post("/api/integrations/meeting", async (c) => {
  try {
    const body = await c.req.json<{
      contact_id?: string;
      summary?: string;
      start_datetime?: string;
      timezone?: string;
      duration_minutes?: number;
    }>();
    const contactId = (body.contact_id || "").trim();
    const summary = (body.summary || "").trim();
    const start = (body.start_datetime || "").trim();
    if (!contactId) return c.json({ error: "contact_id is required" }, 400);
    if (!summary) return c.json({ error: "A meeting title is required" }, 400);
    if (!start) return c.json({ error: "A start time is required" }, 400);

    const contact = await get<{ email: string }>("SELECT email FROM contacts WHERE id = ?", [contactId]);
    if (!contact) return c.json({ error: "Contact not found" }, 404);

    const durationMinutes = Number(body.duration_minutes) || 30;
    const timezone = (body.timezone || "").trim() || "UTC";
    await createMeeting(c.env, {
      summary,
      startDatetime: start,
      timezone,
      durationHour: Math.floor(durationMinutes / 60),
      durationMinutes: durationMinutes % 60,
      attendees: contact.email ? [contact.email] : [],
    });
    await logActivity("contact", contactId, "meeting", summary, { start, timezone });
    return c.json({ ok: true }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Contact import (CSV / XLSX, mapped client-side) ────────────────
// The client parses the file and maps headers → fields, then posts clean rows
// here. Company names resolve to ids (reusing existing, creating new), then the
// contacts are bulk-inserted.
//
// This is written set-based, not row-by-row: company lookups use `IN (…)` and
// inserts use multi-row `VALUES (…),(…)`, chunked to stay under D1's 100
// bound-parameter cap (the same cap the preview-tier Facet enforces). A 2000-row
// import is ~150 statements, not ~2400 — it stays well inside the Worker's
// subrequest/duration budget and goes through @clawnify/db unchanged (so it also
// works on the DO-Facet preview binding, which has no batch()).
//
// Ceiling: chunks are not one atomic transaction (the adapter exposes no
// batch()/transaction). Companies are created before contacts so a mid-import
// failure can't orphan a contact's company_id; re-running is safe for companies
// (deduped by name) but may duplicate contacts. Upgrade to a single transaction
// if @clawnify/db ever exposes batch().

const CONTACT_STATUSES = ["founder", "investor", "lp", "operator", "other"];
const LOOKUP_CHUNK = 100; // one-param `name IN (…)` lookups
// Widest company insert is (id, name, domain, industry, phone) = 5 params/row.
// D1 caps bound parameters at 100 per query, so chunk at 100/5 = 20 rows.
const COMPANY_COLS = 5;
const COMPANY_INSERT_CHUNK = Math.floor(100 / COMPANY_COLS); // 20 rows/stmt → 100 params ≤ 100

// Personal/free email providers (gmail, outlook, …) — a company is never
// inferred from these, else every import would spawn a "Gmail" company. Sourced
// from the maintained `free-email-domains` list (~12.8k domains) so it stays
// current via dependency bumps rather than hand-curation.
const FREEMAIL_DOMAINS = new Set(freemailDomains.map((d) => d.toLowerCase()));

// The domain of a work email, or "" if it has none or is a free provider.
function workEmailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 0) return "";
  const domain = email.slice(at + 1).trim().toLowerCase();
  if (!domain || !domain.includes(".")) return "";
  return FREEMAIL_DOMAINS.has(domain) ? "" : domain;
}

/** Find a company whose stored domain resolves to `domain` (tolerating
 *  protocol / www / trailing slash), else create a lightweight one named after
 *  the domain. Used to auto-link a contact to a company from its work email. */
async function findOrCreateCompanyByDomain(domain: string): Promise<string> {
  const existing = await get<{ id: string }>(
    `SELECT id FROM companies
      WHERE lower(replace(replace(replace(rtrim(domain,'/'),'https://',''),'http://',''),'www.','')) = ?
      LIMIT 1`,
    [domain],
  );
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const sld = domain.split(".")[0] || domain;
  const name = sld.charAt(0).toUpperCase() + sld.slice(1);
  await run("INSERT INTO companies (id, name, domain) VALUES (?, ?, ?)", [id, name, domain]);
  return id;
}

// A first-guess company name from a domain: "acme.com" → "Acme". Crude but
// editable post-import, matching how HubSpot seeds domain-derived companies.
function companyNameFromDomain(domain: string): string {
  const label = domain.replace(/^www\./, "").split(".")[0] || domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

app.post("/api/contacts/import", async (c) => {
  try {
    const body = await c.req.json<{
      contacts?: Array<{
        first_name?: string;
        last_name?: string;
        email?: string;
        phone?: string;
        title?: string;
        status?: string;
        company?: string;
        company_domain?: string;
        company_industry?: string;
        company_phone?: string;
        custom?: Record<string, unknown>;
      }>;
      // Opt-in: infer/associate a company from each contact's work-email domain
      // when the row has no explicit company column.
      inferCompanyFromEmail?: boolean;
    }>();
    const rows = Array.isArray(body.contacts) ? body.contacts : [];
    if (rows.length === 0) return c.json({ error: "No rows to import" }, 400);
    if (rows.length > 2000) return c.json({ error: "Import is limited to 2000 rows at a time" }, 400);
    const inferFromEmail = body.inferCompanyFromEmail === true;

    // Keep only rows with at least a first name; normalize fields. `inferDomain`
    // is the work-email domain to build a company from — set only when opted in,
    // the row has no explicit company, and the email domain isn't a free provider.
    const clean = rows
      .map((r) => {
        const email = (r.email || "").trim();
        const company = (r.company || "").trim();
        return {
          first_name: (r.first_name || "").trim(),
          last_name: (r.last_name || "").trim(),
          email,
          phone: (r.phone || "").trim(),
          title: (r.title || "").trim(),
          status: CONTACT_STATUSES.includes((r.status || "").trim()) ? (r.status as string).trim() : "founder",
          company,
          company_domain: (r.company_domain || "").trim(),
          company_industry: (r.company_industry || "").trim(),
          company_phone: (r.company_phone || "").trim(),
          inferDomain: inferFromEmail && !company && email ? workEmailDomain(email) : "",
          custom: r.custom && typeof r.custom === "object" ? r.custom : undefined,
        };
      })
      .filter((r) => r.first_name);
    const skipped = rows.length - clean.length;
    if (clean.length === 0) return c.json({ error: "No rows had a first name to import" }, 400);

    // ── Resolve company names → ids (set-based, case-insensitive) ──
    // Distinct names, keeping the first-seen original casing for any we create.
    // Company attributes (domain/industry/phone) are captured from the first
    // row that carries each one, so a new company lands fully populated instead
    // of as a name-only stub.
    type CompanyDraft = { name: string; domain: string; industry: string; phone: string };
    const nameByKey = new Map<string, CompanyDraft>();
    for (const r of clean) {
      if (!r.company) continue;
      const key = r.company.toLowerCase();
      const existing = nameByKey.get(key);
      if (!existing) {
        nameByKey.set(key, { name: r.company, domain: r.company_domain, industry: r.company_industry, phone: r.company_phone });
      } else {
        if (!existing.domain) existing.domain = r.company_domain;
        if (!existing.industry) existing.industry = r.company_industry;
        if (!existing.phone) existing.phone = r.company_phone;
      }
    }
    const companyIds = new Map<string, number>(); // lowercased name → id

    const loadIds = async (names: string[]) => {
      for (const group of chunk(names, LOOKUP_CHUNK)) {
        const placeholders = group.map(() => "?").join(", ");
        const found = await query<{ id: string; name: string }>(
          `SELECT id, name FROM companies WHERE name COLLATE NOCASE IN (${placeholders})`,
          group,
        );
        for (const co of found) companyIds.set(co.name.toLowerCase(), co.id);
      }
    };

    const allNames = [...nameByKey.values()].map((co) => co.name);
    await loadIds(allNames);

    // Create the ones that don't exist yet (multi-row insert), then reload ids.
    // Existing companies are reused untouched — dedupe-by-name wins, so we never
    // overwrite an established company's attributes from an import.
    const missing = [...nameByKey].filter(([key]) => !companyIds.has(key)).map(([, co]) => co);
    for (const group of chunk(missing, COMPANY_INSERT_CHUNK)) {
      const placeholders = group.map(() => "(?, ?, ?, ?, ?)").join(", ");
      const params = group.flatMap((co) => [crypto.randomUUID(), co.name, co.domain, co.industry, co.phone]);
      await run(`INSERT INTO companies (id, name, domain, industry, phone) VALUES ${placeholders}`, params);
    }
    if (missing.length) await loadIds(missing.map((co) => co.name));

    // ── Infer companies from work-email domains (opt-in) ──
    // Runs after the name phase so a domain match can land on a company that
    // phase just created (e.g. a mapped "Acme" with domain acme.com absorbs a
    // contact whose email is @acme.com). Existing companies match by domain
    // first; unmatched domains create a company named from the domain.
    const domainSet = new Set<string>();
    for (const r of clean) if (r.inferDomain) domainSet.add(r.inferDomain);

    const companyIdByDomain = new Map<string, string>(); // domain (lower) → id (UUID)
    const loadIdsByDomain = async (domainsList: string[]) => {
      for (const group of chunk(domainsList, LOOKUP_CHUNK)) {
        const placeholders = group.map(() => "?").join(", ");
        const found = await query<{ id: string; domain: string }>(
          `SELECT id, domain FROM companies WHERE domain <> '' AND domain COLLATE NOCASE IN (${placeholders})`,
          group,
        );
        for (const co of found) if (co.domain) companyIdByDomain.set(co.domain.toLowerCase(), co.id);
      }
    };

    const allDomains = [...domainSet];
    if (allDomains.length) await loadIdsByDomain(allDomains);

    const missingDomains = allDomains.filter((d) => !companyIdByDomain.has(d));
    for (const group of chunk(missingDomains, COMPANY_INSERT_CHUNK)) {
      const placeholders = group.map(() => "(?, ?, ?)").join(", ");
      const params = group.flatMap((d) => [crypto.randomUUID(), companyNameFromDomain(d), d]);
      await run(`INSERT INTO companies (id, name, domain) VALUES ${placeholders}`, params);
    }
    if (missingDomains.length) await loadIdsByDomain(missingDomains);

    const companiesCreated = missing.length + missingDomains.length;

    // ── Bulk-insert contacts (multi-row VALUES, chunked) ──
    // Mapped custom-field columns ride along in the same INSERT. Chunk size is
    // derived from the real column count so bound params stay ≤ 100 (D1 cap).
    const custom = await resolveImportCustomColumns("contact", clean);
    const builtinCols = ["id", "first_name", "last_name", "email", "phone", "company_id", "title", "status"];
    const cols = [...builtinCols, ...custom.keys.map(quoteIdent)];
    const rowsPerStmt = Math.max(1, Math.floor(100 / cols.length));
    const rowPlaceholder = `(${cols.map(() => "?").join(", ")})`;

    let imported = 0;
    for (const group of chunk(clean, rowsPerStmt)) {
      const placeholders = group.map(() => rowPlaceholder).join(", ");
      const params: unknown[] = [];
      for (const r of group) {
        const companyId = r.company
          ? companyIds.get(r.company.toLowerCase()) ?? null
          : r.inferDomain
            ? companyIdByDomain.get(r.inferDomain) ?? null
            : null;
        params.push(crypto.randomUUID(), r.first_name, r.last_name, r.email, r.phone, companyId, r.title, r.status);
        for (const k of custom.keys) params.push(coerceForImport(r.custom?.[k], custom.defByKey.get(k)!));
      }
      await run(`INSERT INTO contacts (${cols.join(", ")}) VALUES ${placeholders}`, params);
      imported += group.length;
    }

    return c.json({ imported, companiesCreated, skipped }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Bulk company import (CSV / XLSX) ────────────────────────────────
// Dedupe by name (case-insensitive): a company whose name already exists is
// skipped, never duplicated or overwritten. New companies land with their
// built-in columns + any mapped custom fields.
app.post("/api/companies/import", async (c) => {
  try {
    const body = await c.req.json<{
      companies?: Array<{
        name?: string;
        domain?: string;
        industry?: string;
        location?: string;
        phone?: string;
        email?: string;
        notes?: string;
        custom?: Record<string, unknown>;
      }>;
    }>();
    const rows = Array.isArray(body.companies) ? body.companies : [];
    if (rows.length === 0) return c.json({ error: "No rows to import" }, 400);
    if (rows.length > 2000) return c.json({ error: "Import is limited to 2000 rows at a time" }, 400);

    // Keep only rows with a name; collapse to the first-seen row per name so a
    // duplicated name in the file resolves to one company (first wins).
    const byKey = new Map<string, {
      name: string; domain: string; industry: string; location: string; phone: string; email: string; notes: string;
      custom?: Record<string, unknown>;
    }>();
    for (const r of rows) {
      const name = (r.name || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (byKey.has(key)) continue;
      byKey.set(key, {
        name,
        domain: (r.domain || "").trim(),
        industry: (r.industry || "").trim(),
        location: (r.location || "").trim(),
        phone: (r.phone || "").trim(),
        email: (r.email || "").trim(),
        notes: (r.notes || "").trim(),
        custom: r.custom && typeof r.custom === "object" ? r.custom : undefined,
      });
    }
    const named = rows.filter((r) => (r.name || "").trim()).length;
    const noName = rows.length - named; // rows with no company name at all
    const fileDuplicates = named - byKey.size; // same name repeated within the file
    if (byKey.size === 0) return c.json({ error: "No rows had a company name to import" }, 400);

    // Which names already exist → skip those (dedupe).
    const existing = new Set<string>();
    const names = [...byKey.values()].map((co) => co.name);
    for (const group of chunk(names, LOOKUP_CHUNK)) {
      const placeholders = group.map(() => "?").join(", ");
      const found = await query<{ name: string }>(
        `SELECT name FROM companies WHERE name COLLATE NOCASE IN (${placeholders})`,
        group,
      );
      for (const co of found) existing.add(co.name.toLowerCase());
    }
    const fresh = [...byKey].filter(([key]) => !existing.has(key)).map(([, co]) => co);
    // Duplicates = names repeated within the file + names that already exist.
    const duplicates = fileDuplicates + (byKey.size - fresh.length);

    // Bulk-insert new companies + mapped custom columns (chunk from col count).
    const custom = await resolveImportCustomColumns("company", fresh);
    const builtinCols = ["id", "name", "domain", "industry", "location", "phone", "email", "notes"];
    const cols = [...builtinCols, ...custom.keys.map(quoteIdent)];
    const rowsPerStmt = Math.max(1, Math.floor(100 / cols.length));
    const rowPlaceholder = `(${cols.map(() => "?").join(", ")})`;

    let imported = 0;
    for (const group of chunk(fresh, rowsPerStmt)) {
      const placeholders = group.map(() => rowPlaceholder).join(", ");
      const params: unknown[] = [];
      for (const co of group) {
        params.push(crypto.randomUUID(), co.name, co.domain, co.industry, co.location, co.phone, co.email, co.notes);
        for (const k of custom.keys) params.push(coerceForImport(co.custom?.[k], custom.defByKey.get(k)!));
      }
      await run(`INSERT INTO companies (${cols.join(", ")}) VALUES ${placeholders}`, params);
      imported += group.length;
    }

    return c.json({ imported, skipped: noName, duplicates }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Single contact (for deep-linked detail view) ───────────────────

app.get("/api/contacts/:id", async (c) => {
  try {
    const id = c.req.param("id");
    if (!id || id === "all") return c.json({ error: "Not found" }, 404);
    const contact = await get(
      `SELECT ct.*, co.name as company_name, co.domain as company_domain
       FROM contacts ct LEFT JOIN companies co ON ct.company_id = co.id
       WHERE ct.id = ?`,
      [id],
    );
    if (!contact) return c.json({ error: "Contact not found" }, 404);
    return c.json({ contact }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 500);
  }
});

// ── Custom properties (field definitions + schema-sync) ────────────

app.get("/api/custom-fields", async (c) => {
  const entity = c.req.query("entity");
  if (entity && !isEntityType(entity)) return c.json({ error: "Invalid entity" }, 400);
  const defs = await listDefs(entity ? (entity as EntityType) : undefined);
  return c.json({ defs }, 200);
});

app.post("/api/custom-fields", async (c) => {
  try {
    const body = await c.req.json();
    if (!isEntityType(body.entity_type)) return c.json({ error: "Invalid entity_type" }, 400);
    if (!body.key || !body.label) return c.json({ error: "key and label are required" }, 400);
    const def = await createDef({
      entity_type: body.entity_type,
      key: String(body.key),
      label: String(body.label),
      field_type: body.field_type ?? "string",
      custom_field: body.custom_field ?? "",
      options: body.options ?? {},
      position: body.position ?? 0,
    });
    return c.json({ def }, 201);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.put("/api/custom-fields/:id", async (c) => {
  try {
    const def = await updateDef(c.req.param("id"), await c.req.json());
    if (!def) return c.json({ error: "Not found" }, 404);
    return c.json({ def }, 200);
  } catch (err: unknown) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.delete("/api/custom-fields/:id", async (c) => {
  const ok = await deleteDef(c.req.param("id"));
  if (!ok) return c.json({ error: "Not found" }, 404);
  return c.json({ ok: true }, 200);
});

export default app;
