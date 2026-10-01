import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import {
  phases,
  waitTriage,
  tuningPaths,
  sqlSnippets,
  redFlags,
  type CheckItem,
} from "@/lib/awr-data";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "AWR Analysis Runbook — Oracle DBA Triage Checklist" },
      {
        name: "description",
        content:
          "A step-by-step Oracle AWR analysis runbook: verification rules, thresholds, wait-event triage, SQL hotspot isolation, memory advisory rules and tuning paths.",
      },
      { property: "og:title", content: "AWR Analysis Runbook — Oracle DBA Triage Checklist" },
      {
        property: "og:description",
        content:
          "Work an AWR report top-down: time budget, wait events, SQL hotspots, memory advisories, with explicit thresholds and tuning paths.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const STORAGE_KEY = "awr-runbook-progress";

const TABS = [
  { id: "runbook", label: "Runbook" },
  { id: "waits", label: "Wait triage" },
  { id: "paths", label: "Tuning paths" },
  { id: "sql", label: "SQL kit" },
  { id: "flags", label: "Red flags" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function Index() {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [tab, setTab] = useState<TabId>("runbook");
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setChecked(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(checked));
  }, [checked, hydrated]);

  const total = useMemo(() => phases.reduce((n, p) => n + p.items.length, 0), []);
  const done = useMemo(
    () => phases.reduce((n, p) => n + p.items.filter((i) => checked[i.id]).length, 0),
    [checked],
  );
  const pct = total ? Math.round((done / total) * 100) : 0;

  const toggle = (id: string) => setChecked((c) => ({ ...c, [id]: !c[id] }));

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-4 px-5 py-3">
          <div className="mr-auto">
            <h1 className="font-mono text-base font-bold tracking-tight text-foreground">
              AWR<span className="text-primary">::</span>RUNBOOK
            </h1>
            <p className="text-xs text-muted-foreground">
              Oracle AWR triage — rules, thresholds, tuning paths
            </p>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono text-xs text-muted-foreground">
              {done}/{total} · {pct}%
            </span>
            <button
              onClick={() => setChecked({})}
              className="rounded-md border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
            >
              reset
            </button>
          </div>
        </div>
        <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 pb-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`whitespace-nowrap rounded-md px-3 py-1.5 font-mono text-xs transition-colors ${
                tab === t.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-5 py-8">
        {tab === "runbook" && <Runbook checked={checked} toggle={toggle} />}
        {tab === "waits" && <WaitTriage />}
        {tab === "paths" && <TuningPaths />}
        {tab === "sql" && <SqlKit />}
        {tab === "flags" && <RedFlags />}
      </main>

      <footer className="border-t border-border py-6 text-center font-mono text-xs text-muted-foreground">
        One bottleneck · one change · one measurement.
      </footer>
    </div>
  );
}

function SectionTitle({ kicker, title, sub }: { kicker: string; title: string; sub?: string }) {
  return (
    <div className="mb-5">
      <span className="font-mono text-xs uppercase tracking-[0.2em] text-accent">{kicker}</span>
      <h2 className="mt-1 text-xl font-bold text-foreground">{title}</h2>
      {sub && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Runbook({
  checked,
  toggle,
}: {
  checked: Record<string, boolean>;
  toggle: (id: string) => void;
}) {
  return (
    <div className="space-y-8">
      <SectionTitle
        kicker="step-by-step"
        title="Work the report top-down"
        sub="Each step has a verification rule and a hard threshold. Do not skip ahead to SQL before the time budget is established."
      />
      {phases.map((p) => {
        const d = p.items.filter((i) => checked[i.id]).length;
        return (
          <section key={p.id} className="panel p-5">
            <div className="mb-4 flex flex-wrap items-baseline gap-3 border-b border-border pb-3">
              <span className="font-mono text-2xl font-bold text-primary">{p.code}</span>
              <h3 className="text-lg font-semibold text-foreground">{p.title}</h3>
              <span className="ml-auto font-mono text-xs text-muted-foreground">
                {d}/{p.items.length}
              </span>
              <p className="w-full text-sm text-muted-foreground">{p.goal}</p>
            </div>
            <ul className="space-y-2">
              {p.items.map((item) => (
                <CheckRow
                  key={item.id}
                  item={item}
                  checked={!!checked[item.id]}
                  onToggle={() => toggle(item.id)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function CheckRow({
  item,
  checked,
  onToggle,
}: {
  item: CheckItem;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li
      className={`rounded-md border p-3 transition-colors ${
        checked ? "border-ok/40 bg-ok/5" : "border-border bg-secondary/30"
      }`}
    >
      <label className="flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="mt-1 size-4 shrink-0 accent-[var(--ok)]"
        />
        <div className="min-w-0">
          <span
            className={`block text-sm font-medium ${
              checked ? "text-muted-foreground line-through" : "text-foreground"
            }`}
          >
            {item.title}
          </span>
          <p className="mt-1.5 font-mono text-xs text-muted-foreground">
            <span className="text-accent">where&gt;</span> {item.how}
          </p>
          <p className="mt-1 font-mono text-xs text-warn">
            <span className="opacity-70">rule&gt;</span> {item.threshold}
          </p>
          {item.note && (
            <p className="mt-1.5 border-l-2 border-accent/50 pl-2 text-xs italic text-muted-foreground">
              {item.note}
            </p>
          )}
        </div>
      </label>
    </li>
  );
}

function WaitTriage() {
  return (
    <div>
      <SectionTitle
        kicker="cheat sheet"
        title="Wait event triage"
        sub="Rank by % of DB time first, then read the average wait. High count with low average is a SQL problem; low count with high average is infrastructure."
      />
      <div className="panel overflow-x-auto">
        <table className="w-full min-w-[46rem] text-left text-sm">
          <thead>
            <tr className="border-b border-border font-mono text-xs uppercase tracking-wider text-muted-foreground">
              <th className="p-3">Event / signal</th>
              <th className="p-3">Likely cause</th>
              <th className="p-3">Threshold</th>
              <th className="p-3">First action</th>
            </tr>
          </thead>
          <tbody>
            {waitTriage.map((r) => (
              <tr key={r.signal} className="border-b border-border/60 last:border-0">
                <td className="p-3 font-mono text-xs text-primary">{r.signal}</td>
                <td className="p-3 text-muted-foreground">{r.likelyCause}</td>
                <td className="p-3 font-mono text-xs text-warn">{r.threshold}</td>
                <td className="p-3 text-foreground">{r.action}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TuningPaths() {
  return (
    <div>
      <SectionTitle
        kicker="decision trees"
        title="SQL tuning paths"
        sub="Pick the path that matches the symptom. Follow it in order and stop as soon as the measurement confirms the fix."
      />
      <div className="grid gap-4 md:grid-cols-2">
        {tuningPaths.map((p) => (
          <div key={p.symptom} className="panel p-5">
            <h3 className="mb-3 text-sm font-semibold text-primary">{p.symptom}</h3>
            <ol className="space-y-2">
              {p.steps.map((s, i) => (
                <li key={s} className="flex gap-3 text-sm text-muted-foreground">
                  <span className="font-mono text-xs text-accent">{String(i + 1).padStart(2, "0")}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </div>
  );
}

function SqlKit() {
  return (
    <div>
      <SectionTitle
        kicker="queries"
        title="SQL kit"
        sub="The statements behind each step, ready to paste into SQL*Plus or SQLcl."
      />
      <div className="space-y-4">
        {sqlSnippets.map((s) => (
          <div key={s.title} className="panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-border px-4 py-2">
              <h3 className="font-mono text-xs uppercase tracking-wider text-accent">{s.title}</h3>
              <CopyButton text={s.sql} />
            </div>
            <pre className="overflow-x-auto p-4 font-mono text-xs leading-relaxed text-foreground">
              {s.sql}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary"
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function RedFlags() {
  return (
    <div>
      <SectionTitle
        kicker="do not"
        title="Red flags in AWR analysis"
        sub="Habits that produce confident, wrong conclusions."
      />
      <ul className="grid gap-3 md:grid-cols-2">
        {redFlags.map((f) => (
          <li key={f} className="panel flex gap-3 p-4 text-sm text-foreground">
            <span className="font-mono text-crit">!</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
