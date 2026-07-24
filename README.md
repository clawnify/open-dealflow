# Dealflow: The Open-Source Affinity Alternative for VCs

A dealflow CRM for investors — startups, people, a VC pipeline, and a warm-intro relationship graph. Self-hosted, agent-ready, and free. Built for funds that are priced out of Affinity's ~$2,000/seat and don't want to bend HubSpot into something it isn't.

Built with **React + Tailwind + shadcn/ui** on **Hono + SQLite**. Path-based routing, UUID keys, dark mode that follows the OS, and a dual-mode UI: one for humans and one for AI agents (larger targets, always-visible actions).

## What Is It?

Dealflow is a purpose-built venture CRM you can self-host, customize, and own. Think of it as an open-source Affinity alternative — the entities are the ones a fund actually works with:

- **Companies** — the startups in your universe (sector, location, one-liner)
- **People** — founders, co-investors, LPs, operators, typed as such
- **Deals** — a pipeline with real VC stages: *Sourced → Screening → Partner meeting → Diligence → Term sheet → Invested / Passed*
- **The relationship graph** — who knows whom, how well, and from where — so "who can intro me to this company?" is a query, not a Slack scramble

Unlike the incumbents, this runs on your own infrastructure with no per-seat pricing and no vendor lock-in. Your deal flow and LP data live in your database, not someone else's cloud.

## Features

- **VC-native pipeline** — a board with per-stage counts and totals; check size, round, and valuation on every deal. Stages are data, not code: rename, recolor, reorder, add ("IC review"), or delete them — semantics (won/passed) ride on flags, so any vocabulary works
- **Warm-intro paths** — `GET /api/network/intro-paths?company_id=…` returns who in your network can introduce you, strongest relationships first
- **Referral tracking** — every deal records who sourced it, so you know which relationships actually produce deal flow
- **Pass memory** — passing requires a reason, logged to the deal's timeline; "why did we pass on X last year?" is always answerable
- **Activity timeline** — emails, meetings, notes, and stage changes all log to a feed per person, company, and deal
- **Custom fields** — define typed columns at runtime (deal score, source channel, fund number) — real indexed columns, not a JSON blob
- **CSV / XLSX import** — map columns, preview, import; companies resolve by name or are inferred from work-email domains
- **Integrations** — email a founder via Gmail, schedule meetings via Google Calendar, and announce closed investments in Slack
- **Dual-mode UI** — human-optimized + AI-agent-optimized (`?agent=true`); dark mode follows the OS
- **API-first** — every feature is a documented REST endpoint (`/api/openapi.json`), so an AI agent can run the whole system

## Run It With an AI Agent

The fastest way to use Dealflow is with an AI employee doing the data entry. Deploy it on [Clawnify](https://clawnify.com) and your agent becomes the relationship-intelligence layer: forward it a deck and the deal appears in the pipeline; tell it "we're passing" and the reason is logged; ask it "who can intro me to Voltway?" and it answers from the graph.

[**Deploy with Clawnify →**](https://app.clawnify.com/deploy?repo=clawnify/open-dealflow)

## Quickstart (self-hosted)

```bash
git clone https://github.com/clawnify/open-dealflow.git
cd open-dealflow
pnpm install
pnpm run dev
```

Open `http://localhost:5173` in your browser.

### Agent Mode (for browser automation)

Append `?agent=true` to the URL for an agent-friendly UI: explicit Edit/Delete buttons on every row, larger click targets, always-visible actions, and semantic labels on all interactive elements. The human UI stays unchanged.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, Tailwind v4, shadcn/ui, TypeScript, Vite |
| **Backend** | Hono (TypeScript, serverless-ready) |
| **Database** | SQLite via `@clawnify/db` |
| **Integrations** | `@clawnify/connections` (Gmail, Google Calendar, Slack) |
| **Icons** | Lucide |

### Prerequisites

- Node.js 22+
- pnpm (or npm/yarn)

## Architecture

```
src/
  server/
    schema.sql        — SQLite schema (companies, contacts, deals, relationships, activities)
    index.ts          — Hono REST API (CRUD + network + import + custom fields)
    custom-fields.ts  — Typed custom-column registry + schema sync
    integrations.ts   — Gmail / Calendar / Slack via org connections
  client/
    components/
      deals/          — Pipeline board + deal dialog (round, valuation, referred-by, pass reason)
      contacts/       — People table, detail view with NETWORK + ACTIVITY zones
      companies/      — Startup table + dialogs
    lib/stages.ts     — The VC stage vocabulary
```

### Data Model

```sql
companies     (id, name, domain, industry, location, phone, email, notes)
contacts      (id, first_name, last_name, email, phone, company_id → companies, title, status)
deals         (id, name, contact_id → contacts, value, stage → stages.key, round, valuation,
               source_contact_id → contacts, pass_reason, close_date, notes)
stages        (key, label, color, position, is_won, is_lost)
relationships (id, contact_id → contacts, knows_contact_id → contacts, strength, context)
activities    (id, entity_type, entity_id, type, body, meta)
```

`contacts.status` is the relationship type (`founder | investor | lp | operator | other`). `relationships` is a directed graph — mutual relationships store both edges. Warm-intro lookup is a two-hop join: target company → its people → who knows them.

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats` | Counts + active pipeline value |
| GET/POST/PUT/DELETE | `/api/companies` | Startup CRUD (paginated, searchable) |
| GET/POST/PUT/DELETE | `/api/contacts` | People CRUD (typed: founder/investor/lp/…) |
| GET/POST/PUT/DELETE | `/api/deals` | Deal CRUD (stage, round, valuation, source, pass reason) |
| GET | `/api/deals/board` | The full pipeline board |
| GET/POST/PUT/DELETE | `/api/stages` | Editable pipeline vocabulary (colors, order, won/lost flags) |
| GET | `/api/network/intro-paths` | Warm-intro paths to a company or person |
| GET | `/api/contacts/:id/relationships` | A person's edges in the graph |
| POST/DELETE | `/api/relationships` | Record / remove who-knows-whom |
| GET/POST | `/api/activities` | Timeline read / note |
| POST | `/api/contacts/import` · `/api/companies/import` | Bulk CSV/XLSX import |
| GET/POST/PUT/DELETE | `/api/custom-fields` | Typed custom-column registry |

## License

MIT
