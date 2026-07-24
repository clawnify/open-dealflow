import { useState } from "react";
import { Trash2, Plus, Search, Settings, Type as TypeIcon, Hash, Calendar, User, Link2, List, ToggleLeft, CircleDot } from "lucide-react";
import { useCrm } from "@/context";
import { PageHeader } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableHeader, TableBody, TableHead, TableRow, TableCell } from "@/components/ui/table";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  WIDGETS,
  BASE_TYPES,
  widgetMetaFor,
  createCustomField,
  deleteCustomField,
} from "@/lib/custom-fields";
import type { AttributeType, CustomFieldDef, EntityType } from "@/types";

const ENTITIES: { key: EntityType; label: string }[] = [
  { key: "contact", label: "People" },
  { key: "company", label: "Companies" },
  { key: "deal", label: "Deals" },
];

// Combined type picker: bare base types + custom widgets, each with a stable id.
const TYPE_OPTIONS = [
  ...BASE_TYPES.map((b) => ({ id: `base:${b.field_type}`, ...b })),
  ...WIDGETS.map((w) => ({ id: `widget:${w.uid}`, ...w })),
];

// ── Built-in (system) attributes per entity ───────────────────────────
// Static by design: a template's built-ins are fixed — they mirror schema.sql
// and the server's BUILTIN_COLUMNS. Shown alongside custom defs so the whole
// schema is legible in one table (the Attio "Attributes" pattern).

interface BuiltinAttr {
  label: string;
  key: string;
  type: string;
  icon: typeof TypeIcon;
  constraints?: string;
}

const BUILTINS: Record<EntityType, BuiltinAttr[]> = {
  contact: [
    { label: "First name", key: "first_name", type: "Text", icon: TypeIcon, constraints: "Required" },
    { label: "Last name", key: "last_name", type: "Text", icon: TypeIcon },
    { label: "Email", key: "email", type: "Text", icon: TypeIcon },
    { label: "Phone", key: "phone", type: "Text", icon: TypeIcon },
    { label: "Company", key: "company_id", type: "Record", icon: Link2 },
    { label: "Title", key: "title", type: "Text", icon: TypeIcon },
    { label: "Type", key: "status", type: "Status", icon: CircleDot, constraints: "Required" },
    { label: "Created at", key: "created_at", type: "Timestamp", icon: Calendar },
  ],
  company: [
    { label: "Name", key: "name", type: "Text", icon: TypeIcon, constraints: "Required" },
    { label: "Domain", key: "domain", type: "Text", icon: Link2 },
    { label: "Sector", key: "industry", type: "Text", icon: TypeIcon },
    { label: "Location", key: "location", type: "Text", icon: TypeIcon },
    { label: "Phone", key: "phone", type: "Text", icon: TypeIcon },
    { label: "Email", key: "email", type: "Text", icon: TypeIcon },
    { label: "Notes", key: "notes", type: "Long text", icon: List },
    { label: "Created at", key: "created_at", type: "Timestamp", icon: Calendar },
  ],
  deal: [
    { label: "Name", key: "name", type: "Text", icon: TypeIcon, constraints: "Required" },
    { label: "Founder", key: "contact_id", type: "Record", icon: User },
    { label: "Check size", key: "value", type: "Number", icon: Hash },
    { label: "Stage", key: "stage", type: "Status", icon: CircleDot, constraints: "Required" },
    { label: "Round", key: "round", type: "Text", icon: TypeIcon },
    { label: "Valuation", key: "valuation", type: "Number", icon: Hash },
    { label: "Referred by", key: "source_contact_id", type: "Record", icon: User },
    { label: "Pass reason", key: "pass_reason", type: "Long text", icon: List },
    { label: "Close date", key: "close_date", type: "Date", icon: Calendar },
    { label: "Notes", key: "notes", type: "Long text", icon: List },
    { label: "Created at", key: "created_at", type: "Timestamp", icon: Calendar },
  ],
};

export function PropertiesPage() {
  const { customFields, refetchCustomFields, setError } = useCrm();
  const [entity, setEntity] = useState<EntityType>("contact");

  return (
    <>
      <PageHeader title="Attributes" />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <p className="mb-4 max-w-xl text-sm text-muted-foreground">
          Every field on your records — built-in system attributes plus the custom ones you add. Custom
          attributes are real, typed columns and work with an empty database.
        </p>
        <Tabs value={entity} onValueChange={(v) => setEntity(v as EntityType)}>
          <TabsList>
            {ENTITIES.map((e) => (
              <TabsTrigger key={e.key} value={e.key}>{e.label}</TabsTrigger>
            ))}
          </TabsList>
          {ENTITIES.map((e) => (
            <TabsContent key={e.key} value={e.key} className="mt-4">
              <EntityAttributes
                entity={e.key}
                defs={customFields.filter((d) => d.entity_type === e.key)}
                onChanged={refetchCustomFields}
                onError={(m) => setError(m)}
              />
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </>
  );
}

function SystemBadge() {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-xs text-muted-foreground">
      <Settings className="size-3" />
      System
    </span>
  );
}

function EntityAttributes({
  entity,
  defs,
  onChanged,
  onError,
}: {
  entity: EntityType;
  defs: CustomFieldDef[];
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [q, setQ] = useState("");

  const remove = async (def: CustomFieldDef) => {
    if (!confirm(`Delete "${def.label}"? This removes the column and its values for every ${entity}.`)) return;
    try {
      await deleteCustomField(def.id);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to delete attribute");
    }
  };

  const needle = q.trim().toLowerCase();
  const matches = (label: string, key: string) =>
    !needle || label.toLowerCase().includes(needle) || key.toLowerCase().includes(needle);

  const builtins = BUILTINS[entity].filter((b) => matches(b.label, b.key));
  const customs = defs.filter((d) => matches(d.label, d.key));

  return (
    <div className="max-w-3xl space-y-6">
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search attributes" className="pl-8" />
      </div>

      <div className="overflow-hidden rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Constraints</TableHead>
              <TableHead>Properties</TableHead>
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {builtins.map((b) => (
              <TableRow key={b.key}>
                <TableCell>
                  <span className="inline-flex items-center gap-2 font-medium">
                    <b.icon className="size-4 shrink-0 text-muted-foreground" />
                    {b.label}
                  </span>
                </TableCell>
                <TableCell className="text-muted-foreground">{b.type}</TableCell>
                <TableCell className="text-muted-foreground">{b.constraints ?? ""}</TableCell>
                <TableCell><SystemBadge /></TableCell>
                <TableCell />
              </TableRow>
            ))}
            {customs.map((def) => {
              const w = widgetMetaFor(def);
              const Icon = w?.icon ?? BASE_TYPES.find((b) => b.field_type === def.field_type)?.icon ?? TypeIcon;
              return (
                <TableRow key={def.id}>
                  <TableCell>
                    <span className="inline-flex items-center gap-2 font-medium">
                      <Icon className="size-4 shrink-0 text-muted-foreground" />
                      {def.label}
                      <span className="font-mono text-xs font-normal text-muted-foreground">{def.key}</span>
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{w?.label ?? def.field_type}</TableCell>
                  <TableCell className="text-muted-foreground">{def.options.required === true ? "Required" : ""}</TableCell>
                  <TableCell />
                  <TableCell>
                    <button onClick={() => remove(def)} aria-label={`Delete ${def.label}`}
                      className="text-muted-foreground hover:text-destructive">
                      <Trash2 className="size-4" />
                    </button>
                  </TableCell>
                </TableRow>
              );
            })}
            {builtins.length === 0 && customs.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                  No attributes match "{q}".
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <AddAttribute entity={entity} existingKeys={defs.map((d) => d.key)} onChanged={onChanged} onError={onError} />
    </div>
  );
}

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([0-9])/, "f_$1");
}

function AddAttribute({
  entity,
  existingKeys,
  onChanged,
  onError,
}: {
  entity: EntityType;
  existingKeys: string[];
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [typeId, setTypeId] = useState(TYPE_OPTIONS[0].id);
  const [enumText, setEnumText] = useState("");
  const [min, setMin] = useState("0");
  const [max, setMax] = useState("100");
  const [required, setRequired] = useState(false);
  const [busy, setBusy] = useState(false);

  const selected = TYPE_OPTIONS.find((t) => t.id === typeId)!;
  const key = slugify(label);
  const isEnum = selected.field_type === "enumeration";
  const isScore = selected.uid === "clawnify::score.score";
  const dupKey = existingKeys.includes(key);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || !key || dupKey) return;
    const options: Record<string, unknown> = {};
    if (isEnum) options.enum = enumText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (isScore) { options.min = Number(min) || 0; options.max = Number(max) || 100; }
    if (required) options.required = true;
    setBusy(true);
    try {
      await createCustomField({
        entity_type: entity,
        key,
        label: label.trim(),
        field_type: selected.field_type as AttributeType,
        custom_field: selected.uid,
        options,
      });
      setLabel(""); setEnumText(""); setTypeId(TYPE_OPTIONS[0].id); setRequired(false);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Failed to create attribute");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border border-border p-4">
      <div className="eyebrow">New attribute</div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="prop-label">Label</Label>
          <Input id="prop-label" value={label} placeholder="Fit Score" onChange={(e) => setLabel(e.target.value)} />
          {key && <span className="font-mono text-xs text-muted-foreground">{key}{dupKey && " — already exists"}</span>}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label>Type</Label>
          <Select value={typeId} onValueChange={setTypeId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  <span className="inline-flex items-center gap-2"><t.icon className="size-3.5 opacity-60" />{t.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isEnum && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="prop-enum">Values (one per line)</Label>
          <textarea id="prop-enum" value={enumText} onChange={(e) => setEnumText(e.target.value)}
            placeholder={"Immediate\nStrong\nMonitor"}
            className="min-h-[80px] rounded-md border border-input bg-transparent px-2 py-1.5 font-mono text-sm" />
        </div>
      )}
      {isScore && (
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5"><Label htmlFor="prop-min">Min</Label>
            <Input id="prop-min" type="number" value={min} onChange={(e) => setMin(e.target.value)} /></div>
          <div className="flex flex-col gap-1.5"><Label htmlFor="prop-max">Max</Label>
            <Input id="prop-max" type="number" value={max} onChange={(e) => setMax(e.target.value)} /></div>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)}
          className="size-4 rounded border-input" />
        Required — records can't be created without a value
      </label>

      <Button type="submit" size="sm" disabled={busy || !label.trim() || !key || dupKey} className="gap-1.5">
        <Plus className="size-3.5" /> {busy ? "Adding…" : "Add attribute"}
      </Button>
    </form>
  );
}
