import { useCallback, useEffect, useRef, useState } from "react";
import {
  KeyRound,
  Play,
  Globe,
  ScrollText,
  ShieldQuestion,
  Check,
  X,
  ShieldCheck,
  ShieldAlert,
  Sun,
  Moon,
  RefreshCw,
  Lock,
  LockKeyhole,
  LockKeyholeOpen,
  Search,
  Plus,
  ChevronRight,
  ChevronDown,
  Settings as SettingsIcon,
} from "lucide-react";
import {
  api,
  type ApprovalRow,
  type AuditRow,
  type BiometricStatus,
  type EndpointRow,
  type Health,
  type RefRow,
  type RunResult,
  type TaskRow,
} from "@/lib/api";
import { cn, describeEvent, when } from "@/lib/utils";
import { SecretRow, type RowStatus } from "@/components/secret-row";
import { useAutosave } from "@/hooks/use-autosave";
import { AddSecret } from "@/components/add-secret";
import { DEFAULT_ISSUER, grouped, isExpanded, loadCollapsed, saveCollapsed } from "@/lib/group";
import { loadTheme, saveTheme } from "@/lib/theme";

type Tab = "secrets" | "approvals" | "tasks" | "endpoints" | "audit" | "settings";

const TABS: { id: Tab; label: string; icon: typeof KeyRound }[] = [
  { id: "secrets", label: "Secrets", icon: KeyRound },
  { id: "approvals", label: "Approvals", icon: ShieldQuestion },
  { id: "tasks", label: "Tasks", icon: Play },
  { id: "endpoints", label: "Endpoints", icon: Globe },
  { id: "audit", label: "Audit", icon: ScrollText },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
      {children}
    </div>
  );
}

function Panel({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-line bg-card">
      <header className="flex items-baseline justify-between border-b border-line px-4 py-2.5">
        <h2 className="font-display text-sm font-600 text-foreground">{title}</h2>
        {note && <Eyebrow>{note}</Eyebrow>}
      </header>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-8 text-center font-mono text-xs text-muted-foreground">
      {children}
    </div>
  );
}

/** A one-word state in a settings row. Colour carries the verdict. */
function State({
  tone,
  children,
}: {
  tone: "primary" | "muted" | "destructive";
  children: React.ReactNode;
}) {
  const tones = {
    primary: "text-primary",
    muted: "text-muted-foreground",
    destructive: "text-destructive",
  } as const;
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[10px] uppercase tracking-wider",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

/**
 * The vault line in Settings. One place for the wording, because the same
 * state drives the header lock, the row controls and this panel.
 */
function vaultCopy(
  status: BiometricStatus | null,
  open: boolean,
): { label: string; note: string } {
  if (status === null) {
    return { label: "checking", note: "Checking this build…" };
  }
  if (!status.available) {
    return {
      label: "not available",
      note: "No vault in this build: protected items cannot be written here.",
    };
  }
  if (open) {
    return {
      label: "unlocked",
      note: "Unlocked for this session: protected values read silently until the app closes.",
    };
  }
  if (status.vault_ready) {
    return {
      label: "ready",
      note: "One Touch ID authorization opens every protected value for the rest of the session.",
    };
  }
  return {
    label: "not set up",
    note: "Nothing is protected yet. Use the fingerprint control on a row to add one.",
  };
}

export default function App() {
  const [tab, setTab] = useState<Tab>("secrets");
  const [dark, setDark] = useState(() => loadTheme() === "dark");
  const [refs, setRefs] = useState<RefRow[]>([]);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [endpoints, setEndpoints] = useState<EndpointRow[]>([]);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [envs, setEnvs] = useState<string[]>([]);
  const [env, setEnv] = useState("default");
  const [health, setHealth] = useState<Health | null>(null);
  const [biometrics, setBiometrics] = useState<BiometricStatus | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  /** Revealed values, by reference. Membership is what "revealed" means. */
  const [revealed, setRevealed] = useState<Record<string, string>>({});
  /** Whether the vault is open: protected values read silently until close. */
  const [vaultOpen, setVaultOpen] = useState(false);
  /** Edits not yet written. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);
  /** What is typed in the search box. Empty means the whole inventory. */
  const [query, setQuery] = useState("");
  /**
   * Where the inline add form sits: at the foot of a group, or directly under
   * one row. One piece of state, because there is only ever one form.
   */
  const [addAt, setAddAt] = useState<{ issuer: string; after?: string } | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  /** Session ordering keeps a run of entries together, even while saving. */
  const [entryOrder, setEntryOrder] = useState<string[]>([]);
  const localRows = useRef(new Map<string, RefRow>());
  const pendingReads = useRef(new Map<string, Promise<string>>());
  const pendingProtection = useRef(new Set<string>());
  /** Groups the user has folded away. Remembered across restarts. */
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const [result, setResult] = useState<(RunResult & { task: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  // An empty value is a half-finished edit, not an instruction to store
  // nothing — the backend refuses it anyway, so never send one.
  const commit = useCallback(async (reference: string, value: string) => {
    try {
      await api.save(reference, value);
    } catch (e) {
      setError(`${reference} was not saved: ${String(e)}`);
      throw e;
    }
    // Keep deliberately revealed rows visible, without revealing newly added
    // secrets or reopening a row the user hid while its write was pending.
    setRevealed((r) => reference in r ? { ...r, [reference]: value } : r);
    setDrafts((d) => {
      // Only retire the draft if it is still the text that was just written.
      // Typing carries on while a write is in the air, and discarding the
      // newer text would snap the field back to the older value — which then
      // becomes what the next save stores.
      if (d[reference] !== value) return d;
      const { [reference]: _, ...rest } = d;
      return rest;
    });
    // A reference that had nothing behind it now does, so drop the badge
    // without waiting for a reload.
    setRefs((rows) =>
      rows.map((row) =>
        row.reference === reference && !row.present ? { ...row, present: true } : row,
      ),
    );
    const local = localRows.current.get(reference);
    if (local) localRows.current.set(reference, { ...local, present: true });
  }, []);

  const { state: saveState, schedule, flush, flushAll, cancel, isBusy } = useAutosave<string>(commit);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [r, t, e, a, v, h, p] = await Promise.all([
        api.refs(),
        api.tasks(),
        api.endpoints(),
        api.audit(),
        api.environments(),
        api.health(),
        api.approvals(),
      ]);
      // A refresh must not erase an optimistic row or a failed entry's draft.
      const received = new Set(r.map((row) => row.reference));
      for (const row of r) {
        if (row.present && localRows.current.get(row.reference)?.present) {
          localRows.current.delete(row.reference);
        }
      }
      setRefs([...r, ...[...localRows.current.values()].filter((row) => !received.has(row.reference))]);
      setTasks(t);
      setEndpoints(e);
      setAudit(a);
      setEnvs(v);
      setHealth(h);
      setApprovals(p);
      if (v.length > 0 && !v.includes(env)) setEnv(v[0]);
    } catch (err) {
      setError(String(err));
    }
  }, [env]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    saveTheme(dark ? "dark" : "light");
  }, [dark]);

  // Settings asks the capability question when it is opened, so no other tab
  // pays for a keychain query it never shows. Nothing here reads a value.
  useEffect(() => {
    if (tab !== "settings") return;
    let live = true;
    api
      .biometrics()
      .then((status) => {
        if (live) setBiometrics(status);
      })
      .catch((err) => {
        if (live) setError(String(err));
      });
    return () => {
      live = false;
    };
  }, [tab]);

  // A pending edit must not be lost to a window switch, a tab change, or the
  // app closing. Each of these is a moment the user considers the edit done.
  useEffect(() => {
    window.addEventListener("blur", flushAll);
    window.addEventListener("beforeunload", flushAll);
    return () => {
      window.removeEventListener("blur", flushAll);
      window.removeEventListener("beforeunload", flushAll);
    };
  }, [flushAll]);

  useEffect(() => () => flushAll(), [tab, flushAll]);

  // An agent blocked on a decision is waiting on a person, so poll rather than
  // make them hit refresh. Cheap: it reads one small file.
  useEffect(() => {
    const t = setInterval(() => {
      api.approvals().then(setApprovals).catch(() => {});
    }, 2000);
    return () => clearInterval(t);
  }, []);

  async function decide(id: string, granted: boolean) {
    try {
      await api.decide(id, granted);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  function read(reference: string): Promise<string> {
    const pending = pendingReads.current.get(reference);
    if (pending) return pending;
    const request = api.reveal(reference).finally(() => pendingReads.current.delete(reference));
    pendingReads.current.set(reference, request);
    return request;
  }

  async function enableBiometrics(reference: string) {
    if (pendingProtection.current.has(reference)) return;
    pendingProtection.current.add(reference);
    try {
      await api.enableBiometrics(reference);
      await refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      pendingProtection.current.delete(reference);
    }
  }

  async function unlock() {
    try {
      const ready = await api.unlock();
      setVaultOpen(ready);
      if (!ready) {
        setError("No protected items yet: enable biometrics on a reference first.");
      }
    } catch (err) {
      setError(String(err));
    }
  }

  async function reveal(reference: string) {
    try {
      const value = await read(reference);
      setRevealed((r) => ({ ...r, [reference]: value }));
    } catch (err) {
      setError(String(err));
    }
  }

  function hide(reference: string) {
    // Flush first: hiding a row with an unsaved edit would discard it.
    flush(reference);
    setRevealed((r) => {
      const { [reference]: _, ...rest } = r;
      return rest;
    });
  }

  function edit(reference: string, value: string) {
    setDrafts((d) => ({ ...d, [reference]: value }));
    // An empty field is a half-finished edit; the row says "empty" and nothing
    // is written until there is something to write.
    if (value !== "") schedule(reference, value);
    else cancel(reference);
  }

  function flushDraft(reference: string) {
    const draft = drafts[reference];
    if (draft === "") {
      cancel(reference);
      return;
    }
    // A failed write is no longer queued. Explicit commit retries its draft.
    if (draft !== undefined && !isBusy(reference)) schedule(reference, draft);
    flush(reference);
  }

  function openAfter(row: RefRow) {
    setEntryOrder((order) => order.length ? order : grouped(refs, "").flatMap((group) => group.rows.map((r) => r.reference)));
    setAddAt({ issuer: row.issuer, after: row.reference });
    setFocusRequest((request) => request + 1);
  }

  function addSecret(reference: string, value: string, inline: boolean) {
    const slash = reference.indexOf("/");
    const issuer = slash < 0 ? DEFAULT_ISSUER : reference.slice(0, slash);
    const row: RefRow = {
      reference, issuer, name: slash < 0 ? reference : reference.slice(slash + 1),
      present: false, used_by: [],
    };
    if (!refs.some((existing) => existing.reference === reference)) {
      localRows.current.set(reference, row);
      // Snapshot the visible ordering, then insert under the anchor or append
      // to the provider. Subsequent status changes cannot shuffle these rows.
      const order = grouped(refs, "", entryOrder).flatMap((group) => group.rows.map((r) => r.reference));
      const anchor = inline && addAt?.issuer === issuer ? addAt.after : undefined;
      const after = anchor ? order.indexOf(anchor) : -1;
      order.splice(after < 0 ? order.length : after + 1, 0, reference);
      setEntryOrder(order);
      setRefs((rows) => [...rows, row]);
    }
    setDrafts((drafts) => ({ ...drafts, [reference]: value }));
    schedule(reference, value);
    flush(reference);
    setCollapsed((current) => {
      const next = new Set(current);
      next.delete(issuer);
      saveCollapsed(next);
      return next;
    });
    // A destination outside the current filter must still be visible.
    setQuery("");
    if (inline) openAfter(row);
  }

  async function copy(reference: string) {
    try {
      const value = revealed[reference] ?? (await read(reference));
      await navigator.clipboard.writeText(value);
      setCopied(reference);
      setTimeout(() => setCopied((c) => (c === reference ? null : c)), 1600);
    } catch (err) {
      setError(String(err));
    }
  }

  async function remove(reference: string) {
    try {
      await api.remove(reference);
      localRows.current.delete(reference);
      hide(reference);
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  // Groups are derived from the names, so there is nothing to keep in step.
  const groups = grouped(refs, query, entryOrder);
  /** What the vault can open, over what is on this machine. */
  const protectedCount = refs.filter((row) => row.biometric === true).length;
  const storedCount = refs.filter((row) => row.present).length;
  /** The same state drives the header lock, the row controls and Settings. */
  const vault = vaultCopy(biometrics, vaultOpen);
  const biometricNote =
    biometrics === null
      ? "Checking this build…"
      : biometrics.available
        ? "This build can write to the Data Protection Keychain."
        : biometrics.reason ?? "This build cannot use the Data Protection Keychain.";

  function toggleGroup(issuer: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(issuer)) next.add(issuer);
      saveCollapsed(next);
      return next;
    });
  }

  /** An empty draft is reported as such rather than as an unsaved write. */
  const statusOf = (reference: string): RowStatus | undefined =>
    drafts[reference] === "" ? "empty" : saveState[reference];

  async function run(task: string) {
    setRunning(task);
    setResult(null);
    try {
      const out = await api.runTask(task, env);
      setResult({ ...out, task });
      void refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="min-h-screen bg-background font-sans text-foreground">
      <header className="flex items-center gap-4 border-b border-line px-5 py-3">
        <div className="flex items-center gap-2">
          <Lock size={16} className="text-primary" />
          <span className="font-display text-base font-700 tracking-tight">keymaker</span>
        </div>

        <div className="flex-1" />

        {health && (
          <div
            className="flex items-center gap-1.5 border border-line px-2 py-1"
            title={health.enforcement}
          >
            {health.enforced ? (
              <ShieldCheck size={13} className="text-primary" />
            ) : (
              <ShieldAlert size={13} className="text-destructive" />
            )}
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {health.enforced ? "jail enforced" : "jail not enforced"}
            </span>
          </div>
        )}

        <button
          onClick={() => void unlock()}
          className="p-1.5 text-muted-foreground hover:text-foreground"
          aria-label={vaultOpen ? "Vault unlocked" : "Unlock protected values"}
          title={
            vaultOpen
              ? "Vault unlocked: protected values read silently until the app closes"
              : "Unlock protected values with one Touch ID authorization"
          }
        >
          {vaultOpen ? <LockKeyholeOpen size={15} /> : <LockKeyhole size={15} />}
        </button>
        <button
          onClick={() => void refresh()}
          className="p-1.5 text-muted-foreground hover:text-foreground"
          aria-label="Refresh"
          title="Refresh"
        >
          <RefreshCw size={15} />
        </button>
        <button
          onClick={() => setDark((d) => !d)}
          className="p-1.5 text-muted-foreground hover:text-foreground"
          aria-label="Toggle theme"
        >
          {dark ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </header>

      <nav className="flex gap-0 border-b border-line px-5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "flex items-center gap-1.5 border-b-2 px-3 py-2.5 font-mono text-[11px] uppercase tracking-wider",
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon size={13} />
            {label}
            {id === "approvals" && approvals.length > 0 && (
              <span className="ml-0.5 bg-primary px-1 text-[10px] font-600 text-primary-foreground">
                {approvals.length}
              </span>
            )}
          </button>
        ))}
      </nav>

      <main className="mx-auto max-w-5xl space-y-5 p-5">
        {error && (
          <div className="border border-destructive/40 bg-destructive/5 px-4 py-2.5 font-mono text-xs text-destructive">
            {error}
          </div>
        )}

        {tab === "secrets" && (
          <>
            <Panel
              title="Secrets"
              note={`${refs.filter((r) => r.present).length} of ${refs.length} stored here`}
            >
              {/* Search is the interface: the inventory is small enough that
                  typing beats navigating, and an empty box is the full list. */}
              <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                <Search size={14} className="shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setQuery("")}
                  placeholder="filter by reference or project…"
                  className="min-w-0 flex-1 bg-transparent font-mono text-xs focus:outline-none"
                  aria-label="Filter secrets"
                />
                {query && (
                  <button
                    onClick={() => setQuery("")}
                    className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground"
                  >
                    clear
                  </button>
                )}
              </div>

              <AddSecret onCommit={(reference, value) => addSecret(reference, value, false)} />

              {groups.length === 0 ? (
                <Empty>
                  {refs.length === 0
                    ? "Nothing stored yet. Add a secret above — name it issuer/key, like stripe/api-key, and the group appears on its own."
                    : `Nothing matches “${query}”.`}
                </Empty>
              ) : (
                groups.map((group) => {
                  const expanded = isExpanded(group.issuer, collapsed, query);
                  return (
                  <div key={group.issuer}>
                    <div className="sticky top-0 z-10 flex items-center border-b border-line bg-secondary/60 backdrop-blur">
                      {/* The whole header is the toggle; the add button sits
                          outside it so a click there does not fold the group. */}
                      <button
                        onClick={() => toggleGroup(group.issuer)}
                        className="flex min-w-0 flex-1 items-center gap-2 px-4 py-1.5 text-left hover:bg-secondary"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${group.issuer}`}
                      >
                        {expanded ? (
                          <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
                        ) : (
                          <ChevronRight size={13} className="shrink-0 text-muted-foreground" />
                        )}
                        <span className="font-mono text-[11px] uppercase tracking-wider text-foreground">
                          {group.issuer}
                        </span>
                        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          {group.stored} of {group.rows.length}
                        </span>
                      </button>
                      <button
                        onClick={() => {
                          // Adding into a folded group would put the form where
                          // its result cannot be seen.
                          setCollapsed((c) => {
                            if (!c.has(group.issuer)) return c;
                            const next = new Set(c);
                            next.delete(group.issuer);
                            saveCollapsed(next);
                            return next;
                          });
                          setAddAt((at) =>
                            at?.issuer === group.issuer && at.after === undefined
                              ? null
                              : { issuer: group.issuer },
                          );
                        }}
                        className="px-4 py-1.5 text-muted-foreground hover:text-primary"
                        title={`Add a key under ${group.issuer}`}
                        aria-label={`Add a key under ${group.issuer}`}
                      >
                        <Plus size={13} />
                      </button>
                    </div>

                    {expanded && (
                    <div className="border-l border-line ml-4">
                    {group.rows.map((r) => (
                      <div key={r.reference}>
                        <SecretRow
                          row={r}
                          revealed={r.reference in revealed ? revealed[r.reference] : null}
                          draft={drafts[r.reference]}
                          status={statusOf(r.reference)}
                          copied={copied === r.reference}
                          onReveal={() => void reveal(r.reference)}
                          onHide={() => hide(r.reference)}
                          onChange={(v) => edit(r.reference, v)}
                          onFlush={() => flushDraft(r.reference)}
                          onEnter={() => openAfter(r)}
                          onCopy={() => void copy(r.reference)}
                          onDelete={() => void remove(r.reference)}
                          onEnableBiometrics={() => void enableBiometrics(r.reference)}
                        />
                        {/* Enter on any row opens the next one directly
                            beneath it, wherever in the list it was. */}
                        {addAt?.after === r.reference && (
                          <AddSecret
                            prefill={`${r.issuer}/`}
                            focusRequest={focusRequest}
                            onCommit={(reference, value) => addSecret(reference, value, true)}
                            onCancel={() => setAddAt(null)}
                          />
                        )}
                      </div>
                    ))}
                    {/* Or at the foot of the group, when added from its
                        header — where the key will appear, not above what
                        already exists. */}
                    {addAt?.issuer === group.issuer && addAt.after === undefined && (
                      <AddSecret
                        prefill={`${group.issuer}/`}
                        focusRequest={focusRequest}
                        onCommit={(reference, value) => addSecret(reference, value, true)}
                        onCancel={() => setAddAt(null)}
                      />
                    )}
                    </div>
                    )}
                  </div>
                  );
                })
              )}
            </Panel>
            <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
              Name a key <span className="text-foreground">issuer/key</span> and it files
              itself — there are no groups to create. Edits save themselves a moment after
              you stop typing, and immediately when you leave the field. This window is the only place a value can be read —
              the CLI and the MCP surface have no such command, which is the point of
              them. Every reveal is written to the audit log.
            </p>
          </>
        )}

        {tab === "approvals" && (
          <>
            <Panel
              title="Waiting for a decision"
              note={approvals.length === 0 ? "nothing waiting" : `${approvals.length} pending`}
            >
              {approvals.length === 0 ? (
                <Empty>
                  When a policy stops an agent, the request appears here for you to
                  answer. Nothing is waiting.
                </Empty>
              ) : (
                approvals.map((a) => (
                  <div key={a.id} className="border-b border-line px-4 py-3 last:border-b-0">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-sm">{a.capability}</div>
                        <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                          stopped by: {a.rule}
                        </div>
                        {a.detail && (
                          <div className="mt-1 border border-line bg-background px-2 py-1 font-mono text-[11px]">
                            {a.detail}
                          </div>
                        )}
                        <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                          lapses in {a.seconds_left}s
                        </div>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <button
                          onClick={() => void decide(a.id, true)}
                          className="flex items-center gap-1 border border-primary px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-primary hover:bg-primary hover:text-primary-foreground"
                        >
                          <Check size={12} />
                          approve
                        </button>
                        <button
                          onClick={() => void decide(a.id, false)}
                          className="flex items-center gap-1 border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-muted-foreground hover:border-destructive hover:text-destructive"
                        >
                          <X size={12} />
                          deny
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </Panel>
            <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
              One approval authorises one call, and lapses if nobody answers. An agent
              cannot approve its own request — the MCP tool for it grants nothing.
            </p>
          </>
        )}

        {tab === "tasks" && (
          <>
            <div className="flex items-center gap-2">
              <Eyebrow>Environment</Eyebrow>
              <select
                value={env}
                onChange={(e) => setEnv(e.target.value)}
                className="border border-line bg-background px-2 py-1 font-mono text-xs focus:border-primary focus:outline-none"
              >
                {(envs.length ? envs : ["default"]).map((e) => (
                  <option key={e}>{e}</option>
                ))}
              </select>
            </div>

            <Panel title="Tasks" note="from .keymaker">
              {tasks.length === 0 ? (
                <Empty>No tasks declared. Add a [tasks] section to .keymaker.</Empty>
              ) : (
                tasks.map((t) => (
                  <div
                    key={t.name}
                    className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-sm">{t.name}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {t.command}
                      </div>
                    </div>
                    <button
                      onClick={() => void run(t.name)}
                      disabled={running !== null}
                      className="flex items-center gap-1.5 border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider hover:border-primary hover:text-primary disabled:opacity-40"
                    >
                      <Play size={12} />
                      {running === t.name ? "running" : "run"}
                    </button>
                  </div>
                ))
              )}
            </Panel>

            {result && (
              <Panel
                title={`Output — ${result.task}`}
                note={`exit ${result.exit_code ?? "?"}`}
              >
                <div className="space-y-2 px-4 py-3">
                  {result.redacted && (
                    <div className="border border-primary/40 bg-primary/5 px-3 py-1.5 font-mono text-[11px] text-primary">
                      This task printed a secret value. It has been masked.
                    </div>
                  )}
                  {result.leaked_files.map((f) => (
                    <div
                      key={f}
                      className="border border-destructive/40 bg-destructive/5 px-3 py-1.5 font-mono text-[11px] text-destructive"
                    >
                      This task wrote a credential to {f}
                    </div>
                  ))}
                  {result.stdout && (
                    <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-foreground">
                      {result.stdout}
                    </pre>
                  )}
                  {result.stderr && (
                    <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-muted-foreground">
                      {result.stderr}
                    </pre>
                  )}
                </div>
              </Panel>
            )}
          </>
        )}

        {tab === "endpoints" && (
          <Panel title="Endpoints" note={`${endpoints.length} defined`}>
            {endpoints.length === 0 ? (
              <Empty>
                No endpoint definitions found. Drop one in .keymaker.endpoints.toml.
              </Empty>
            ) : (
              endpoints.map((e) => (
                <div
                  key={e.name}
                  className="flex items-center gap-3 border-b border-line px-4 py-3 last:border-b-0"
                >
                  <span className="w-14 shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    {e.method}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-sm">{e.name}</div>
                    <div className="truncate font-mono text-[11px] text-muted-foreground">
                      {e.host}
                      {e.path}
                    </div>
                  </div>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                    {e.secret}
                  </span>
                  {e.gated && (
                    <span
                      className="shrink-0 border border-primary/50 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-primary"
                      title="Policy stops this for a person"
                    >
                      needs approval
                    </span>
                  )}
                </div>
              ))
            )}
          </Panel>
        )}

        {tab === "audit" && (
          <Panel
            title="Audit"
            note={
              health
                ? health.audit_intact
                  ? `${health.audit_entries} entries · chain intact`
                  : "CHAIN BROKEN"
                : undefined
            }
          >
            {health && !health.audit_intact && (
              <div className="border-b border-destructive/40 bg-destructive/5 px-4 py-2 font-mono text-[11px] text-destructive">
                The audit chain does not verify. An entry has been edited or removed.
              </div>
            )}
            {audit.length === 0 ? (
              <Empty>Nothing recorded yet.</Empty>
            ) : (
              [...audit].reverse().map((row) => {
                const { kind, detail } = describeEvent(row.summary);
                return (
                  <div
                    key={row.seq}
                    className="flex gap-3 border-b border-line px-4 py-2 last:border-b-0"
                  >
                    <span className="w-10 shrink-0 text-right font-mono text-[11px] text-muted-foreground">
                      {row.seq}
                    </span>
                    <span className="w-36 shrink-0 font-mono text-[11px] text-muted-foreground">
                      {when(row.at)}
                    </span>
                    <span className="w-40 shrink-0 font-mono text-[11px] text-foreground">
                      {kind}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                      {detail}
                    </span>
                  </div>
                );
              })
            )}
          </Panel>
        )}

        {tab === "settings" && (
          <>
            <Panel title="Appearance" note="this window">
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm">Theme</div>
                  <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                    Remembered on this machine.
                  </div>
                </div>
                <div className="flex shrink-0 border border-line">
                  {(["light", "dark"] as const).map((choice) => (
                    <button
                      key={choice}
                      onClick={() => setDark(choice === "dark")}
                      aria-pressed={(choice === "dark") === dark}
                      className={cn(
                        "px-3 py-1 font-mono text-[11px] uppercase tracking-wider",
                        (choice === "dark") === dark
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
              </div>
            </Panel>

            <Panel title="Biometrics" note="macOS · per item">
              <div className="flex items-start gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm">Touch ID support</div>
                  <div className="mt-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {biometricNote}
                  </div>
                </div>
                <State
                  tone={biometrics?.available ? "primary" : "muted"}
                >
                  {biometrics === null
                    ? "checking"
                    : biometrics.available
                      ? "available"
                      : "unavailable"}
                </State>
              </div>

              <div className="flex items-start gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm">Vault</div>
                  <div className="mt-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {vault.note}
                  </div>
                </div>
                <State
                  tone={
                    vaultOpen
                      ? "primary"
                      : biometrics?.vault_ready
                        ? "primary"
                        : "muted"
                  }
                >
                  {vault.label}
                </State>
              </div>

              <div className="flex items-start gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm">Protected references</div>
                  <div className="mt-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    Values the open vault reads without another prompt.
                  </div>
                </div>
                <span className="shrink-0 font-mono text-[11px] text-foreground">
                  {protectedCount} of {storedCount}
                </span>
              </div>

              <div className="flex items-center gap-3 px-4 py-3">
                <p className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  Protection is per reference and deliberate. Protecting one a
                  task or endpoint needs unattended makes that path prompt — or
                  fail — on every read.
                </p>
                <button
                  onClick={() => void unlock()}
                  disabled={!biometrics?.available || !biometrics.vault_ready || vaultOpen}
                  className="flex shrink-0 items-center gap-1.5 border border-line px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider hover:border-primary hover:text-primary disabled:opacity-40"
                >
                  {vaultOpen ? <LockKeyholeOpen size={12} /> : <LockKeyhole size={12} />}
                  {vaultOpen ? "unlocked" : "unlock"}
                </button>
              </div>
            </Panel>

            <Panel title="This machine" note="enforcement and evidence">
              <div className="flex items-start gap-3 border-b border-line px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm">Agent jail</div>
                  <div className="mt-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {health?.enforcement ?? "unknown"}
                  </div>
                </div>
                <State tone={health?.enforced ? "primary" : "destructive"}>
                  {health?.enforced ? "enforced" : "not enforced"}
                </State>
              </div>
              <div className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-sm">Audit chain</div>
                  <div className="mt-0.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
                    {health
                      ? `${health.audit_entries} ${health.audit_entries === 1 ? "entry" : "entries"}`
                      : "unknown"}
                  </div>
                </div>
                <State tone={health?.audit_intact ? "primary" : "destructive"}>
                  {health?.audit_intact ? "intact" : "broken"}
                </State>
              </div>
            </Panel>
          </>
        )}
      </main>
    </div>
  );
}
