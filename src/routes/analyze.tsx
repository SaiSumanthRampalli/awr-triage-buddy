import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { parseAwr, type ParsedAwr } from "@/lib/awr-parser";
import { evaluate, score, type Finding, type Status } from "@/lib/awr-rules";

export const Route = createFileRoute("/analyze")({
  head: () => ({
    meta: [
      { title: "AWR Report Analyzer — Upload & Auto-Check" },
      { name: "description", content: "Upload one or more Oracle AWR reports (HTML or text) and get an automatic checklist verdict, wait-event, SQL hotspot and memory findings, plus side-by-side comparison." },
      { property: "og:title", content: "AWR Report Analyzer — Upload & Auto-Check" },
      { property: "og:description", content: "Automatic AWR checklist verification across multiple reports." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: AnalyzePage,
});

type Report = ParsedAwr & { findings: Finding[] };

const STATUS_CLS: Record<Status, string> = {
  pass: "border-ok/40 bg-ok/10 text-ok",
  warn: "border-warn/40 bg-warn/10 text-warn",
  fail: "border-crit/40 bg-crit/10 text-crit",
  na: "border-border bg-muted text-muted-foreground",
};

function Badge({ s }: { s: Status }) {
  return <span className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${STATUS_CLS[s]}`}>{s}</span>;
}

function AnalyzePage() {
  const [reports, setReports] = useState<Report[]>([]);
  const [active, setActive] = useState(0);
  const [drag, setDrag] = useState(false);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Status | "all">("all");

  async function addFiles(list: FileList | null) {
    if (!list?.length) return;
    setBusy(true);
    const next: Report[] = [];
    for (const file of Array.from(list)) {
      if (file.size > 50 * 1024 * 1024) continue;
      const text = await file.text();
      const p = parseAwr(file.name, text);
      next.push({ ...p, findings: evaluate(p.metrics) });
    }
    setReports((r) => [...r, ...next]);
    setBusy(false);
  }

  const cur = reports[active];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-4 px-5 py-3">
          <div className="mr-auto">
            <h1 className="font-mono text-base font-bold tracking-tight text-foreground">
              AWR<span className="text-primary">::</span>ANALYZER
            </h1>
            <p className="text-xs text-muted-foreground">Upload AWR reports · auto-verify the runbook checklist</p>
          </div>
          <Link to="/" className="rounded-md border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground hover:border-primary hover:text-primary">
            ← runbook
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-8 px-5 py-8">
        <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files); }}
          className={`panel flex cursor-pointer flex-col items-center justify-center gap-2 border-2 border-dashed p-10 text-center transition-colors ${drag ? "border-primary" : "border-border"}`}
        >
          <input type="file" multiple accept=".html,.htm,.txt,.lst,.log" className="hidden" onChange={(e) => { addFiles(e.target.files); e.target.value = ""; }} />
          <span className="font-mono text-sm text-primary">{busy ? "parsing…" : "drop AWR reports here or click to browse"}</span>
          <span className="text-xs text-muted-foreground">awrrpt HTML or text · multiple files supported · processed in your browser, nothing is uploaded</span>
        </label>

        {reports.length > 0 && (
          <>
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-lg font-bold text-foreground">Reports ({reports.length})</h2>
                <div className="flex gap-2">
                  <button onClick={() => download(reports)} className="rounded-md bg-primary px-3 py-1.5 font-mono text-xs text-primary-foreground">export markdown</button>
                  <button onClick={() => { setReports([]); setActive(0); }} className="rounded-md border border-border px-3 py-1.5 font-mono text-xs text-muted-foreground hover:text-foreground">clear</button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {reports.map((r, i) => {
                  const c = score(r.findings);
                  return (
                    <button key={i} onClick={() => setActive(i)} className={`panel px-3 py-2 text-left transition-colors ${i === active ? "border-primary" : ""}`}>
                      <div className="max-w-[220px] truncate font-mono text-xs text-foreground">{r.fileName}</div>
                      <div className="mt-1 flex gap-2 font-mono text-[11px]">
                        <span className="text-crit">{c.fail} fail</span>
                        <span className="text-warn">{c.warn} warn</span>
                        <span className="text-ok">{c.pass} pass</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>

            {reports.length > 1 && <Compare reports={reports} />}

            {cur && (
              <section className="space-y-5">
                <div className="panel grid gap-4 p-5 sm:grid-cols-4">
                  <Stat k="Database" v={`${cur.metrics.dbName ?? "?"}${cur.metrics.instance ? ` / ${cur.metrics.instance}` : ""}`} />
                  <Stat k="Release" v={cur.metrics.version ?? "?"} />
                  <Stat k="Window" v={`${cur.metrics.elapsedMin ?? "?"} min · DB time ${cur.metrics.dbTimeMin ?? "?"} min`} />
                  <Stat k="Snaps" v={`${cur.metrics.beginSnap ?? "?"} → ${cur.metrics.endSnap ?? "?"}`} />
                </div>
                {cur.warnings.length > 0 && (
                  <div className="rounded-md border border-warn/40 bg-warn/10 p-3 text-xs text-warn">
                    {cur.warnings.map((w) => <div key={w}>⚠ {w}</div>)}
                  </div>
                )}

                <div className="panel p-5">
                  <div className="mb-3 flex flex-wrap items-center gap-2">
                    <h3 className="mr-auto font-semibold text-foreground">Checklist verdict</h3>
                    {(["all", "fail", "warn", "pass", "na"] as const).map((s) => (
                      <button key={s} onClick={() => setFilter(s)} className={`rounded px-2 py-1 font-mono text-[11px] ${filter === s ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary"}`}>{s}</button>
                    ))}
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left font-mono text-[11px] uppercase text-muted-foreground">
                        <tr className="border-b border-border">
                          <th className="py-2 pr-3">Status</th><th className="pr-3">Phase</th><th className="pr-3">Check</th><th className="pr-3">Observed</th><th className="pr-3">Threshold</th><th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortFindings(cur.findings).filter((x) => filter === "all" || x.status === filter).map((x, i) => (
                          <tr key={i} className="border-b border-border/60 align-top">
                            <td className="py-2 pr-3"><Badge s={x.status} /></td>
                            <td className="whitespace-nowrap pr-3 font-mono text-xs text-muted-foreground">{x.phase}</td>
                            <td className="pr-3 text-foreground">{x.title}</td>
                            <td className="pr-3 font-mono text-xs text-foreground">{x.observed}</td>
                            <td className="pr-3 text-xs text-muted-foreground">{x.threshold}</td>
                            <td className="text-xs text-muted-foreground">{x.action ?? "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="grid gap-5 lg:grid-cols-2">
                  <div className="panel p-5">
                    <h3 className="mb-3 font-semibold text-foreground">Top foreground events</h3>
                    <SimpleTable
                      head={["Event", "Waits", "Time (s)", "Avg ms", "% DB", "Class"]}
                      rows={cur.metrics.events.map((e) => [e.name, fmt(e.waits, 0), fmt(e.timeS), fmt(e.avgMs, 2), fmt(e.pctDbTime), e.waitClass])}
                    />
                  </div>
                  <div className="panel p-5">
                    <h3 className="mb-3 font-semibold text-foreground">Load profile & efficiency</h3>
                    <SimpleTable
                      head={["Metric", "Value"]}
                      rows={[
                        ...Object.entries(cur.metrics.load).map(([k, v]) => [k, fmt(v, 2)]),
                        ...Object.entries(cur.metrics.eff).map(([k, v]) => [k + " %", fmt(v, 2)]),
                        ["PGA cache hit %", fmt(cur.metrics.pgaCacheHit, 2)],
                        ["Host CPU idle %", fmt(cur.metrics.hostCpu.idle)],
                        ["CPUs", fmt(cur.metrics.cpus, 0)],
                      ]}
                    />
                  </div>
                </div>

                <div className="panel p-5">
                  <h3 className="mb-3 font-semibold text-foreground">SQL hotspots — ordered by elapsed time</h3>
                  <SimpleTable
                    head={["SQL Id", "Elapsed (s)", "Execs", "s/exec", "% Total", "Text"]}
                    rows={cur.metrics.sqlElapsed.map((s) => [s.sqlId, fmt(s.elapsedS), fmt(s.execs, 0), fmt(s.perExecS, 3), fmt(s.pctTotal), s.text])}
                  />
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
}

const ORDER: Record<Status, number> = { fail: 0, warn: 1, pass: 2, na: 3 };
const sortFindings = (f: Finding[]) => [...f].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.phase.localeCompare(b.phase));
const fmt = (n: number | null | undefined, d = 1) => (n == null ? "—" : n.toLocaleString(undefined, { maximumFractionDigits: d }));

function Stat({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{k}</div>
      <div className="mt-0.5 break-words text-sm text-foreground">{v}</div>
    </div>
  );
}

function SimpleTable({ head, rows }: { head: string[]; rows: (string | undefined)[][] }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">Not found in this report.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead><tr className="border-b border-border text-left font-mono uppercase text-muted-foreground">{head.map((h) => <th key={h} className="py-1.5 pr-3">{h}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-border/50">
              {r.map((c, j) => <td key={j} className={`py-1.5 pr-3 ${j === 0 ? "font-mono text-foreground" : "text-muted-foreground"} ${j === r.length - 1 && head[j] === "Text" ? "max-w-xs truncate" : ""}`}>{c ?? "—"}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Compare({ reports }: { reports: Report[] }) {
  const metric = (label: string, get: (r: Report) => number | undefined | null, d = 1) => ({ label, vals: reports.map(get), d });
  const rows = [
    metric("Elapsed (min)", (r) => r.metrics.elapsedMin),
    metric("DB time (min)", (r) => r.metrics.dbTimeMin),
    metric("DB time/s (AAS)", (r) => r.metrics.load.dbTimePerSec, 2),
    metric("DB CPU/s", (r) => r.metrics.load.dbCpuPerSec, 2),
    metric("Executes/s", (r) => r.metrics.load.executesPerSec, 0),
    metric("Hard parses/s", (r) => r.metrics.load.hardParsesPerSec),
    metric("Logical reads/s", (r) => r.metrics.load.logicalReadsPerSec, 0),
    metric("Physical reads/s", (r) => r.metrics.load.physicalReadsPerSec, 0),
    metric("Buffer hit %", (r) => r.metrics.eff.bufferHit, 2),
    metric("Soft parse %", (r) => r.metrics.eff.softParse, 2),
    metric("PGA cache hit %", (r) => r.metrics.pgaCacheHit, 2),
    metric("Host CPU idle %", (r) => r.metrics.hostCpu.idle),
    metric("Fails", (r) => score(r.findings).fail, 0),
    metric("Warnings", (r) => score(r.findings).warn, 0),
  ];
  return (
    <section className="panel p-5">
      <h3 className="mb-1 font-semibold text-foreground">Side-by-side comparison</h3>
      <p className="mb-3 text-xs text-muted-foreground">First report is the baseline; Δ% shows change vs baseline.</p>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left font-mono text-muted-foreground">
              <th className="py-1.5 pr-3">Metric</th>
              {reports.map((r, i) => <th key={i} className="max-w-[160px] truncate pr-3">{i === 0 ? "baseline · " : ""}{r.fileName}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-border/50">
                <td className="py-1.5 pr-3 font-mono text-foreground">{row.label}</td>
                {row.vals.map((v, i) => {
                  const b = row.vals[0];
                  const d = i > 0 && v != null && b ? ((v - b) / b) * 100 : null;
                  return (
                    <td key={i} className="pr-3 text-muted-foreground">
                      {fmt(v, row.d)}
                      {d != null && Math.abs(d) >= 1 && <span className={`ml-1 ${Math.abs(d) > 25 ? "text-warn" : ""}`}>({d > 0 ? "+" : ""}{d.toFixed(0)}%)</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr>
              <td className="py-1.5 pr-3 font-mono text-foreground">Top event</td>
              {reports.map((r, i) => <td key={i} className="pr-3 text-muted-foreground">{r.metrics.events.find((e) => e.name !== "DB CPU")?.name ?? "—"}</td>)}
            </tr>
            <tr>
              <td className="py-1.5 pr-3 font-mono text-foreground">Top SQL</td>
              {reports.map((r, i) => <td key={i} className="pr-3 font-mono text-muted-foreground">{r.metrics.sqlElapsed[0]?.sqlId ?? "—"}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

function download(reports: Report[]) {
  const lines: string[] = ["# AWR Analysis Report", ""];
  for (const r of reports) {
    const m = r.metrics;
    const c = score(r.findings);
    lines.push(`## ${r.fileName}`, "", `- DB: ${m.dbName ?? "?"} ${m.instance ?? ""} (${m.version ?? "?"})`, `- Window: ${m.elapsedMin ?? "?"} min, DB time ${m.dbTimeMin ?? "?"} min`, `- Result: ${c.fail} fail, ${c.warn} warn, ${c.pass} pass, ${c.na} n/a`, "");
    lines.push("| Status | Phase | Check | Observed | Threshold | Action |", "|---|---|---|---|---|---|");
    sortFindings(r.findings).forEach((x) => lines.push(`| ${x.status.toUpperCase()} | ${x.phase} | ${x.title} | ${x.observed} | ${x.threshold} | ${x.action ?? ""} |`));
    lines.push("", "### Top events", "", "| Event | Avg ms | % DB time | Class |", "|---|---|---|---|");
    m.events.forEach((e) => lines.push(`| ${e.name} | ${fmt(e.avgMs, 2)} | ${fmt(e.pctDbTime)} | ${e.waitClass} |`));
    lines.push("", "### Top SQL by elapsed", "", "| SQL Id | Elapsed s | Execs | % Total |", "|---|---|---|---|");
    m.sqlElapsed.forEach((s) => lines.push(`| ${s.sqlId} | ${fmt(s.elapsedS)} | ${fmt(s.execs, 0)} | ${fmt(s.pctTotal)} |`));
    lines.push("");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "awr-analysis.md";
  a.click();
  URL.revokeObjectURL(a.href);
}
