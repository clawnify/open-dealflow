# Dealflow — agent guide

A dealflow CRM for investors: **companies** (startups), **people** (founders,
investors, LPs, operators), a **deals** pipeline with VC stages, and a
**relationship graph** that powers warm-intro lookups. Plus an activity
timeline and Clawnify integrations. React + Hono + D1.

## Your job: auto-capture

You are the relationship-intelligence layer. The user should almost never have
to log anything by hand. When you learn something from a conversation, an
email, or a forwarded deck, record it here immediately:

- **Forwarded deck / intro email** → create the company (if new) and a deal at
  stage `sourced`. Extract name, sector, round, check size, and valuation from
  the material. Create the founder as a contact (`status: "founder"`) linked to
  the company. If someone referred it, set `source_contact_id`.
- **Meeting happened / email exchanged** → log it on the contact's timeline
  (`POST /api/activities`) so recency is queryable.
- **"We're passing on X"** → set the deal's stage to `passed` AND write
  `pass_reason` in the same update. Never record a pass without its reason —
  "why did we pass?" must be answerable months later.
- **Learned that two people know each other** → record it in the graph
  (`POST /api/relationships`, use `mutual: true` unless clearly one-way).
  This is what makes warm-intro answers possible.

## Core entities

- `GET/POST/PUT/DELETE /api/contacts` · `/api/companies` · `/api/deals`
- Contacts belong to companies; deals belong to contacts (the founder).
- Contact `status` is the relationship type: `founder | investor | lp | operator | other`.
- Deal fields: `value` (check size, USD), `stage`, `round` (pre-seed, seed,
  series-a, …), `valuation`, `source_contact_id` (who referred it), `pass_reason`.
- `GET /api/stats` — counts + total pipeline value (excludes passed deals).

## Pipeline stages (data, not code)

Stages live in the database — `GET /api/stages` is the vocabulary. Defaults:
`sourced → screening → partner_meeting → diligence → term_sheet → invested`,
plus `passed`. Deal writes validate the stage key (400 lists valid keys).

- `POST /api/stages` `{ label, key?, color?, position?, is_won?, is_lost? }` —
  add a stage (e.g. the firm adds an "IC review" step).
- `PUT /api/stages/{key}` — rename, recolor, reorder, or change flags. Key is immutable.
- `DELETE /api/stages/{key}?reassign_to=<key>` — reassign_to is required when
  the stage still has deals.
- **Semantics ride on flags, not names**: moving a deal to an `is_won: 1` stage
  fires the Slack celebration; an `is_lost: 1` stage means passed — set
  `pass_reason` on the deal in the same update.

## Network (warm intros)

- `GET /api/network/intro-paths?company_id=<id>` — who in the network can
  introduce the user to someone at that company. Also accepts `contact_id=`.
  Answer "who can get me into X?" with this — strongest paths come first.
- `GET /api/contacts/{id}/relationships` — a person's edges (both directions).
- `POST /api/relationships` `{ contact_id, knows_contact_id, strength, context, mutual }`
  — strength ∈ `strong | medium | weak`; context is how they know each other.

## Activity timeline

- `GET /api/activities?entity_type=contact&entity_id=<id>` — newest first.
- `POST /api/activities` `{ entity_type, entity_id, type, body }` — log a note.

## Integrations (Clawnify connections)

These use the org's Clawnify connections — no keys live in this app. Check what's
wired first: `GET /api/integrations/status` → `{ email, meeting, slack }`.

- **Email a contact** — `POST /api/integrations/email` `{ contact_id, subject, body }`.
- **Schedule a meeting** — `POST /api/integrations/meeting`
  `{ contact_id, summary, start_datetime, timezone, duration_minutes }`.
  `start_datetime` is local wall-clock (`2026-07-16T13:00:00`); `timezone` is IANA.
- **Investment-closed Slack alert** — when a deal is set to stage `invested`, if
  `SLACK_CHANNEL` is set and Slack is connected, the app posts automatically.

If a capability isn't connected, the endpoint returns an error — tell the user to
connect it in the Clawnify dashboard; don't try to work around it.

## Custom fields

Firms track different things (deal score, source channel, fund). Define real,
typed columns at runtime: `POST /api/custom-fields`
`{ entity_type, key, label, field_type, options }` — then write values flat on
the entity or under `custom`. Unknown fields are rejected loudly (422) with the
valid-field list. Set `options.required: true` to make a field mandatory —
create/update then reject (400) when it's missing or being cleared. Bulk import
stays lenient and does not enforce required.

## Import (CSV / XLSX)

Dashboard UI: People / Companies → **Import**. Programmatically:
`POST /api/contacts/import` `{ contacts: [...], inferCompanyFromEmail: true }` —
company names resolve or are created; work-email domains can infer companies.
`POST /api/companies/import` `{ companies: [...] }` — deduped by name.

## Agent-mode UI

Append `?agent=true` for larger targets and always-visible action buttons.
Screenshot-friendly overview: `/deals` (the pipeline board).
