import { useEffect, useState } from "react";
import { ArrowLeft, Mail, Calendar, StickyNote, MessageSquare, Trophy, UserPlus, X } from "lucide-react";
import { useCrm } from "@/context";
import { Avatar, CategoryBadge } from "@/components/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import { api } from "@/api";
import { cn } from "@/lib/utils";
import type { Contact, Activity, Relationship } from "@/types";

type FormKind = "email" | "meeting" | "note";

const ACTIVITY_STYLE: Record<string, { icon: typeof Mail; className: string }> = {
  email: { icon: Mail, className: "bg-primary/10 text-primary" },
  meeting: { icon: Calendar, className: "bg-orange-100 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400" },
  note: { icon: StickyNote, className: "bg-secondary text-muted-foreground" },
  slack: { icon: MessageSquare, className: "bg-violet-100 text-violet-600 dark:bg-violet-500/10 dark:text-violet-400" },
  stage_change: { icon: Trophy, className: "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400" },
};

function parseMeta(meta: string): Record<string, unknown> {
  try {
    const v = JSON.parse(meta);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function metaLine(meta: Record<string, unknown>): string | null {
  if (typeof meta.to === "string" && meta.to) return `to ${meta.to}`;
  if (typeof meta.channel === "string" && meta.channel) return `#${meta.channel}`;
  return null;
}

function formatTimestamp(createdAt: string): string {
  const d = new Date(createdAt.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? createdAt : d.toLocaleString();
}

export function ContactDetail({ id, navigate }: { id: string; navigate: (to: string) => void }) {
  const { fetchContact, fetchActivities, emailContact, scheduleMeeting, addNote, connections, setError } = useCrm();

  const [contact, setContact] = useState<Contact | null | undefined>(undefined);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [knows, setKnows] = useState<Relationship[]>([]);
  const [knownBy, setKnownBy] = useState<Relationship[]>([]);
  const [addingEdge, setAddingEdge] = useState(false);
  const [edgeContactId, setEdgeContactId] = useState("");
  const [edgeStrength, setEdgeStrength] = useState("medium");
  const [edgeContext, setEdgeContext] = useState("");

  const loadRelationships = async (contactId: string) => {
    try {
      const r = await api<{ knows: Relationship[]; known_by: Relationship[] }>(
        "GET",
        `/api/contacts/${contactId}/relationships`,
      );
      setKnows(r.knows);
      // Mutual relationships create both directions; the reverse edge would
      // render as a duplicate row, so only show one-way "known by" edges.
      setKnownBy(r.known_by.filter((e) => !r.knows.some((k) => k.knows_contact_id === e.contact_id)));
    } catch {
      /* contact may have just been created — the zone simply shows empty */
    }
  };

  const [openForm, setOpenForm] = useState<FormKind | null>(null);
  const [busy, setBusy] = useState(false);

  const [subject, setSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [meetingStart, setMeetingStart] = useState("");
  const [meetingDuration, setMeetingDuration] = useState("30");
  const [noteBody, setNoteBody] = useState("");

  useEffect(() => {
    let alive = true;
    setContact(undefined);
    fetchContact(id).then((c) => {
      if (alive) setContact(c);
    });
    fetchActivities("contact", id).then((a) => {
      if (alive) setActivities(a);
    });
    loadRelationships(id);
    return () => {
      alive = false;
    };
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const reloadActivities = async () => {
    setActivities(await fetchActivities("contact", id));
  };

  if (contact === undefined) {
    return <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">Loading…</div>;
  }

  if (contact === null) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-12 text-center">
        <p className="text-sm text-muted-foreground">Contact not found.</p>
        <Button size="sm" variant="outline" onClick={() => navigate("/contacts")}>
          <ArrowLeft className="size-4" />
          Back to contacts
        </Button>
      </div>
    );
  }

  const fullName = `${contact.first_name} ${contact.last_name}`.trim() || "Contact";
  const subtitle = [contact.title, contact.company_name].filter(Boolean).join(" · ");

  const openFormKind = (kind: FormKind) => {
    if (openForm === kind) {
      setOpenForm(null);
      return;
    }
    setOpenForm(kind);
    if (kind === "email") {
      setSubject("");
      setEmailBody("");
    } else if (kind === "meeting") {
      setMeetingTitle(`Meeting with ${fullName}`);
      setMeetingStart("");
      setMeetingDuration("30");
    } else {
      setNoteBody("");
    }
  };

  const afterAction = async () => {
    setOpenForm(null);
    await reloadActivities();
  };

  const submitEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await emailContact(contact.id, subject, emailBody);
      await afterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send email");
    } finally {
      setBusy(false);
    }
  };

  const submitMeeting = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await scheduleMeeting(contact.id, {
        summary: meetingTitle,
        start_datetime: meetingStart.slice(0, 19),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        duration_minutes: Number(meetingDuration),
      });
      await afterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to schedule meeting");
    } finally {
      setBusy(false);
    }
  };

  const submitNote = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await addNote("contact", contact.id, noteBody);
      await afterAction();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save note");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="border-b border-border px-6 py-3">
        <Button size="sm" variant="ghost" onClick={() => navigate("/contacts")} aria-label="Back to contacts">
          <ArrowLeft className="size-4" />
          Contacts
        </Button>
      </div>

      <div className="mx-auto w-full max-w-2xl p-6">
        <Card className="divide-y divide-border">
          {/* CONTACT */}
          <section className="flex flex-col gap-4 p-6">
            <div className="eyebrow">Contact</div>
            <div className="flex items-start gap-3">
              <Avatar firstName={contact.first_name} lastName={contact.last_name} className="size-11 text-sm" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <div className="flex items-center gap-2">
                  <h1 className="text-lg font-bold tracking-tight">{fullName}</h1>
                  <CategoryBadge value={contact.status} />
                </div>
                {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
              </div>
            </div>
            <dl className="grid gap-1.5 text-sm">
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted-foreground">Email</dt>
                <dd>
                  {contact.email ? (
                    <a href={`mailto:${contact.email}`} className="text-[var(--ring)] hover:underline">
                      {contact.email}
                    </a>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted-foreground">Phone</dt>
                <dd className="tabular">{contact.phone || <span className="text-muted-foreground">—</span>}</dd>
              </div>
            </dl>
          </section>

          {/* ACTIONS */}
          <section className="flex flex-col gap-4 p-6">
            <div className="eyebrow">Actions</div>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => openFormKind("email")}
                disabled={!connections.email}
                title={connections.email ? undefined : "Connect Gmail in Clawnify"}
                aria-label="Send email"
              >
                <Mail className="size-4" />
                Email
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => openFormKind("meeting")}
                disabled={!connections.meeting}
                title={connections.meeting ? undefined : "Connect Google Calendar in Clawnify"}
                aria-label="Schedule meeting"
              >
                <Calendar className="size-4" />
                Meeting
              </Button>
              <Button size="sm" variant="outline" onClick={() => openFormKind("note")} aria-label="Add note">
                <StickyNote className="size-4" />
                Note
              </Button>
            </div>

            {openForm === "email" && (
              <form onSubmit={submitEmail} className="flex flex-col gap-3 rounded-md border border-border p-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email-subject">Subject</Label>
                  <Input id="email-subject" required value={subject} onChange={(e) => setSubject(e.target.value)} />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="email-body">Message</Label>
                  <Textarea id="email-body" required value={emailBody} onChange={(e) => setEmailBody(e.target.value)} />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={busy}>
                    {busy ? "Sending…" : "Send email"}
                  </Button>
                </div>
              </form>
            )}

            {openForm === "meeting" && (
              <form onSubmit={submitMeeting} className="flex flex-col gap-3 rounded-md border border-border p-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="meeting-title">Title</Label>
                  <Input id="meeting-title" required value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="meeting-start">Start</Label>
                    <Input
                      id="meeting-start"
                      type="datetime-local"
                      required
                      value={meetingStart}
                      onChange={(e) => setMeetingStart(e.target.value)}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="meeting-duration">Duration</Label>
                    <Select value={meetingDuration} onValueChange={setMeetingDuration}>
                      <SelectTrigger id="meeting-duration">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["15", "30", "45", "60"].map((m) => (
                          <SelectItem key={m} value={m}>
                            {m} min
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={busy}>
                    {busy ? "Scheduling…" : "Schedule meeting"}
                  </Button>
                </div>
              </form>
            )}

            {openForm === "note" && (
              <form onSubmit={submitNote} className="flex flex-col gap-3 rounded-md border border-border p-4">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="note-body">Note</Label>
                  <Textarea id="note-body" required value={noteBody} onChange={(e) => setNoteBody(e.target.value)} />
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={busy}>
                    {busy ? "Saving…" : "Add note"}
                  </Button>
                </div>
              </form>
            )}
          </section>

          {/* NETWORK */}
          <section className="flex flex-col gap-4 p-6">
            <div className="flex items-center justify-between">
              <div className="eyebrow">Network · {knows.length + knownBy.length}</div>
              <Button size="sm" variant="outline" onClick={() => setAddingEdge((v) => !v)} aria-label="Add relationship">
                <UserPlus className="size-4" />
                Add
              </Button>
            </div>

            {addingEdge && (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!edgeContactId) return;
                  setBusy(true);
                  try {
                    await api("POST", "/api/relationships", {
                      contact_id: contact.id,
                      knows_contact_id: edgeContactId,
                      strength: edgeStrength,
                      context: edgeContext,
                      mutual: true,
                    });
                    setAddingEdge(false);
                    setEdgeContactId("");
                    setEdgeContext("");
                    await loadRelationships(contact.id);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "Failed to add relationship");
                  } finally {
                    setBusy(false);
                  }
                }}
                className="flex flex-col gap-3 rounded-md border border-border p-4"
              >
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="edge-contact">Knows</Label>
                  <Combobox
                    id="edge-contact"
                    value={edgeContactId}
                    onChange={setEdgeContactId}
                    placeholder="Search contacts…"
                    searchPlaceholder="Search contacts…"
                    emptyText="No contacts found."
                    options={[]}
                    onSearch={async (query) => {
                      const { contacts } = await api<{ contacts: { id: string; first_name: string; last_name: string }[] }>(
                        "GET",
                        `/api/contacts?limit=20&search=${encodeURIComponent(query)}`,
                      );
                      return contacts
                        .filter((c) => c.id !== contact.id)
                        .map((c) => ({ value: c.id, label: `${c.first_name} ${c.last_name}`.trim() || "—" }));
                    }}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="edge-strength">Strength</Label>
                    <Select value={edgeStrength} onValueChange={setEdgeStrength}>
                      <SelectTrigger id="edge-strength">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {["strong", "medium", "weak"].map((s) => (
                          <SelectItem key={s} value={s} className="capitalize">
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="edge-context">How they know each other</Label>
                    <Input id="edge-context" value={edgeContext} onChange={(e) => setEdgeContext(e.target.value)} placeholder="e.g. co-invested in 2024" />
                  </div>
                </div>
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={busy || !edgeContactId}>
                    {busy ? "Saving…" : "Add relationship"}
                  </Button>
                </div>
              </form>
            )}

            {knows.length === 0 && knownBy.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No relationships recorded yet. Add who {contact.first_name} knows to power warm-intro lookups.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {knows.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      Knows <span className="font-medium">{r.knows_name}</span>
                      {(r.knows_title || r.knows_company_name) && (
                        <span className="text-muted-foreground">
                          {" "}· {[r.knows_title, r.knows_company_name].filter(Boolean).join(" @ ")}
                        </span>
                      )}
                      {r.context && <span className="text-muted-foreground"> — {r.context}</span>}
                    </span>
                    <CategoryBadge value={r.strength} />
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-7"
                      aria-label={`Remove relationship with ${r.knows_name}`}
                      onClick={async () => {
                        await api("DELETE", `/api/relationships/${r.id}`);
                        await loadRelationships(contact.id);
                      }}
                    >
                      <X className="size-3.5" />
                    </Button>
                  </li>
                ))}
                {knownBy.map((r) => (
                  <li key={r.id} className="flex items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      Known by <span className="font-medium">{r.contact_name}</span>
                      {r.context && <span className="text-muted-foreground"> — {r.context}</span>}
                    </span>
                    <CategoryBadge value={r.strength} />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* ACTIVITY */}
          <section className="flex flex-col gap-4 p-6">
            <div className="eyebrow">Activity</div>
            {activities.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No activity yet. Send an email, schedule a meeting, or add a note.
              </p>
            ) : (
              <ul className="flex flex-col gap-4">
                {[...activities]
                  .sort((a, b) => b.created_at.localeCompare(a.created_at))
                  .map((a) => {
                    const style = ACTIVITY_STYLE[a.type] ?? ACTIVITY_STYLE.note;
                    const Icon = style.icon;
                    const meta = metaLine(parseMeta(a.meta));
                    return (
                      <li key={a.id} className="flex gap-3">
                        <span className={cn("mt-0.5 inline-flex size-7 shrink-0 items-center justify-center rounded-full", style.className)}>
                          <Icon className="size-3.5" />
                        </span>
                        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                          {a.body && <p className="whitespace-pre-wrap text-sm">{a.body}</p>}
                          {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
                          <p className="tabular text-xs text-muted-foreground">{formatTimestamp(a.created_at)}</p>
                        </div>
                      </li>
                    );
                  })}
              </ul>
            )}
          </section>
        </Card>
      </div>
    </div>
  );
}
