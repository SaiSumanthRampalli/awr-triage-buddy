import type { AwrMetrics, WaitEvent } from "./awr-parser";

export type Status = "pass" | "warn" | "fail" | "na";

export type Finding = {
  checkId: string;
  phase: string;
  title: string;
  status: Status;
  observed: string;
  threshold: string;
  action?: string | undefined;
};

const f = (n: number | undefined | null, d = 1) =>
  n == null ? "n/a" : n.toLocaleString(undefined, { maximumFractionDigits: d });

const ev = (m: AwrMetrics, re: RegExp): WaitEvent | undefined => m.events.find((e) => re.test(e.name));

type EvAdvice = { re: RegExp; label: string; warnMs: number; failMs: number; action: string };
const EVENT_LATENCY: EvAdvice[] = [
  { re: /^db file sequential read$/i, label: "db file sequential read", warnMs: 10, failMs: 20, action: "Single-block reads slow: check storage latency; find SQL in 'SQL ordered by Reads'; review index clustering / range scans." },
  { re: /^db file scattered read$/i, label: "db file scattered read", warnMs: 15, failMs: 30, action: "Multiblock read slow or excessive full scans: check missing indexes, partition pruning, storage throughput." },
  { re: /^log file sync$/i, label: "log file sync", warnMs: 5, failMs: 10, action: "Compare with 'log file parallel write'. If LFPW also high → redo disk; else commit frequency / CPU starvation of LGWR." },
  { re: /^log file parallel write$/i, label: "log file parallel write", warnMs: 5, failMs: 10, action: "Redo device latency: move redo to low-latency storage, avoid RAID-5, check redo log size." },
  { re: /^direct path read$/i, label: "direct path read", warnMs: 20, failMs: 40, action: "Serial direct reads on big scans: check for full scans that should be indexed, or storage throughput." },
  { re: /^gc (cr|current) block 2-way$/i, label: "gc block 2-way", warnMs: 1, failMs: 2, action: "Interconnect latency: check private network, MTU, LMS CPU." },
];

export function evaluate(m: AwrMetrics): Finding[] {
  const out: Finding[] = [];
  const push = (x: Finding) => out.push(x);

  // ---- Phase 00 scope
  if (m.elapsedMin == null)
    push({ checkId: "scope-window", phase: "00 Scope", title: "Snapshot window length", status: "na", observed: "not found", threshold: "15-60 min" });
  else
    push({
      checkId: "scope-window",
      phase: "00 Scope",
      title: "Snapshot window length",
      status: m.elapsedMin > 120 || m.elapsedMin < 10 ? "fail" : m.elapsedMin > 60 || m.elapsedMin < 15 ? "warn" : "pass",
      observed: `${f(m.elapsedMin)} min`,
      threshold: "15-60 min ideal; reject >120 or <10",
      action: m.elapsedMin > 60 ? "Re-pull a narrower AWR around the problem peak; long windows average away spikes." : undefined,
    });

  if (m.rac)
    push({ checkId: "scope-rac", phase: "00 Scope", title: "RAC database detected", status: "warn", observed: "RAC = YES", threshold: "Pull per-instance + global reports", action: "Upload each instance's report to compare DB time skew (>30% = imbalance)." });

  const { parsesPerSec: p, hardParsesPerSec: hp } = m.load;
  if (p != null && hp != null) {
    const pct = p ? (hp / p) * 100 : 0;
    push({
      checkId: "scope-load",
      phase: "00 Scope",
      title: "Hard parse rate",
      status: hp > 50 || pct > 5 ? (hp > 100 || pct > 15 ? "fail" : "warn") : "pass",
      observed: `${f(hp)}/s (${f(pct)}% of parses)`,
      threshold: "<5% of parses and <50/s",
      action: hp > 50 || pct > 5 ? "Literal SQL / cursor invalidation: find via FORCE_MATCHING_SIGNATURE, use binds, check cursor_sharing." : undefined,
    });
  }

  // ---- Phase 01 time
  const dbTimeS = (m.dbTimeMin ?? 0) * 60;
  const elapsedS = (m.elapsedMin ?? 0) * 60;
  if (m.dbTimeMin != null && m.elapsedMin) {
    const aas = dbTimeS / elapsedS;
    const cpus = m.cpus;
    push({
      checkId: "time-dbtime",
      phase: "01 Time budget",
      title: "Average Active Sessions (DB time / elapsed)",
      status: cpus ? (aas > cpus * 2 ? "fail" : aas > cpus ? "warn" : "pass") : "na",
      observed: `AAS ${f(aas, 2)}${cpus ? ` vs ${cpus} CPUs` : ""}`,
      threshold: "AAS < CPU count; > 2x CPUs = saturated",
      action: cpus && aas > cpus ? "Demand exceeds CPU: identify top events/SQL; consider queueing in Resource Manager." : undefined,
    });
  }
  const cpu = ev(m, /^DB CPU$/);
  if (cpu?.pctDbTime != null)
    push({
      checkId: "time-model",
      phase: "01 Time budget",
      title: "DB CPU share of DB time",
      status: cpu.pctDbTime < 30 ? "warn" : "pass",
      observed: `${f(cpu.pctDbTime)}%`,
      threshold: "<30% = wait-bound (go to waits); >70% = CPU-bound (go to SQL by CPU / gets)",
      action: cpu.pctDbTime > 70 ? "CPU-bound workload: tune 'SQL ordered by Gets' / 'CPU Time'." : cpu.pctDbTime < 30 ? "Wait-bound: focus on the top non-CPU event below." : undefined,
    });
  const { idle, wio } = m.hostCpu;
  if (idle != null)
    push({
      checkId: "time-os",
      phase: "01 Time budget",
      title: "Host CPU idle",
      status: idle < 10 ? "fail" : idle < 25 ? "warn" : "pass",
      observed: `${f(idle)}% idle${wio != null ? `, ${f(wio)}% WIO` : ""}`,
      threshold: "Idle >25%; <10% means run queue / CPU starvation",
      action: idle < 25 ? "Check OS run queue and non-Oracle processes; CPU starvation inflates every wait." : undefined,
    });

  // ---- Phase 02 waits
  const top = m.events.filter((e) => e.name !== "DB CPU");
  if (top.length) {
    const t1 = top[0]!;
    const bad = /^(enq: TX - row lock contention|library cache|latch|cursor: pin S wait on X|buffer busy waits|free buffer waits|log file switch|enq: HW)/i.test(t1.name);
    push({
      checkId: "wait-top5",
      phase: "02 Waits",
      title: `Top wait: ${t1.name}`,
      status: (t1.pctDbTime ?? 0) > 30 || bad ? "fail" : (t1.pctDbTime ?? 0) > 15 ? "warn" : "pass",
      observed: `${f(t1.pctDbTime)}% DB time, class ${t1.waitClass || "?"}`,
      threshold: "Single non-CPU event >30% DB time is the primary bottleneck",
      action: adviceForEvent(t1.name),
    });
  } else
    push({ checkId: "wait-top5", phase: "02 Waits", title: "Top foreground events", status: "na", observed: "section not parsed", threshold: "—" });

  for (const a of EVENT_LATENCY) {
    const e = ev(m, a.re);
    if (!e || e.avgMs == null) continue;
    push({
      checkId: a.re.source.includes("log file") ? "io-redo" : "wait-avg",
      phase: a.re.source.includes("log file") ? "05 I/O" : "02 Waits",
      title: `${a.label} avg latency`,
      status: e.avgMs > a.failMs ? "fail" : e.avgMs > a.warnMs ? "warn" : "pass",
      observed: `${f(e.avgMs, 2)} ms (${f(e.pctDbTime)}% DB time)`,
      threshold: `<${a.warnMs} ms good, >${a.failMs} ms bad`,
      action: e.avgMs > a.warnMs ? a.action : undefined,
    });
  }

  const classes = new Map<string, number>();
  top.forEach((e) => e.waitClass && classes.set(e.waitClass, (classes.get(e.waitClass) ?? 0) + (e.pctDbTime ?? 0)));
  const conc = (classes.get("Concurrency") ?? 0) + (classes.get("Application") ?? 0);
  if (top.length)
    push({
      checkId: "wait-class",
      phase: "02 Waits",
      title: "Concurrency + Application wait share",
      status: conc > 20 ? "fail" : conc > 10 ? "warn" : "pass",
      observed: `${f(conc)}% DB time`,
      threshold: "<10%; these classes are code/design problems, not hardware",
      action: conc > 10 ? "Row locks, latches, mutexes: look at Segments by Row Lock Waits and application commit design." : undefined,
    });

  // ---- Phase 03 SQL
  const s1 = m.sqlElapsed[0];
  if (s1) {
    push({
      checkId: "sql-elapsed",
      phase: "03 SQL hotspots",
      title: `Top SQL ${s1.sqlId}`,
      status: (s1.pctTotal ?? 0) > 30 ? "fail" : (s1.pctTotal ?? 0) > 10 ? "warn" : "pass",
      observed: `${f(s1.pctTotal)}% DB time, ${f(s1.elapsedS)} s, ${f(s1.execs, 0)} execs, ${f(s1.perExecS, 3)} s/exec`,
      threshold: "One SQL >10% DB time = tuning candidate; >30% = the problem",
      action: (s1.pctTotal ?? 0) > 10 ? `Run awrsqrpt / DBMS_XPLAN.DISPLAY_AWR('${s1.sqlId}') and compare plan_hash_value history.` : undefined,
    });
    const top5 = m.sqlElapsed.slice(0, 5).reduce((a, s) => a + (s.pctTotal ?? 0), 0);
    push({
      checkId: "sql-class",
      phase: "03 SQL hotspots",
      title: "Top-5 SQL concentration",
      status: top5 > 50 ? "warn" : "pass",
      observed: `${f(top5)}% DB time in top 5`,
      threshold: ">50% = concentrated (tune individual SQL); <20% = systemic (look at waits/config)",
    });
    const chatty = m.sqlElapsed.find((s) => (s.execs ?? 0) > 100000 && (s.pctTotal ?? 0) > 5);
    if (chatty)
      push({ checkId: "sql-parse", phase: "03 SQL hotspots", title: `High-frequency SQL ${chatty.sqlId}`, status: "warn", observed: `${f(chatty.execs, 0)} execs`, threshold: "Fast SQL called too often", action: "Reduce call count in application (row-by-row loops, caching, array fetch)." });
  } else push({ checkId: "sql-elapsed", phase: "03 SQL hotspots", title: "SQL ordered by Elapsed Time", status: "na", observed: "not parsed", threshold: "—" });

  const e = m.eff;
  if (e.softParse != null)
    push({ checkId: "sql-parse", phase: "03 SQL hotspots", title: "Soft parse %", status: e.softParse < 90 ? "fail" : e.softParse < 95 ? "warn" : "pass", observed: `${f(e.softParse, 2)}%`, threshold: ">95%", action: e.softParse < 95 ? "Too many hard parses: bind variables, session_cached_cursors." : undefined });
  if (e.executeToParse != null)
    push({ checkId: "sql-parse", phase: "03 SQL hotspots", title: "Execute to Parse %", status: e.executeToParse < 20 ? "warn" : "pass", observed: `${f(e.executeToParse, 2)}%`, threshold: ">50% preferred; low = parse per execute", action: e.executeToParse < 20 ? "Application re-parses each call: keep cursors open, statement caching in driver." : undefined });

  // ---- Phase 04 memory
  if (e.bufferHit != null)
    push({ checkId: "mem-buffer", phase: "04 Memory", title: "Buffer cache hit %", status: e.bufferHit < 90 ? "warn" : "pass", observed: `${f(e.bufferHit, 2)}%`, threshold: "Informational; <90% on OLTP warrants Buffer Pool Advisory review", action: e.bufferHit < 90 ? "Check Buffer Pool Advisory factor 1.0 vs larger sizes before resizing; prefer fixing high-read SQL." : undefined });
  if (e.libraryHit != null)
    push({ checkId: "mem-shared", phase: "04 Memory", title: "Library hit %", status: e.libraryHit < 95 ? "fail" : e.libraryHit < 98 ? "warn" : "pass", observed: `${f(e.libraryHit, 2)}%`, threshold: ">98%", action: e.libraryHit < 98 ? "Shared pool pressure / invalidations: check reloads & invalidations in Library Cache Activity." : undefined });
  if (m.pgaCacheHit != null)
    push({ checkId: "mem-pga", phase: "04 Memory", title: "PGA cache hit %", status: m.pgaCacheHit < 80 ? "fail" : m.pgaCacheHit < 90 ? "warn" : "pass", observed: `${f(m.pgaCacheHit, 2)}%`, threshold: ">90%", action: m.pgaCacheHit < 90 ? "Sorts/hashes spilling to temp: raise PGA_AGGREGATE_TARGET per PGA advisory." : undefined });
  if (m.pgaOverallocAtCurrent != null)
    push({ checkId: "mem-pga", phase: "04 Memory", title: "PGA over-allocation at current size", status: m.pgaOverallocAtCurrent > 0 ? "fail" : "pass", observed: `${f(m.pgaOverallocAtCurrent, 0)}`, threshold: "Must be 0", action: m.pgaOverallocAtCurrent > 0 ? "PGA target too small: increase to the smallest factor with overalloc = 0." : undefined });
  if (m.sgaAdvice) {
    const gain = ((m.sgaAdvice.currentDbTime - m.sgaAdvice.bestDbTime) / (m.sgaAdvice.currentDbTime || 1)) * 100;
    push({ checkId: "mem-sga", phase: "04 Memory", title: "SGA Target Advisory gain", status: gain > 20 ? "warn" : "pass", observed: `${f(gain)}% DB time saving at factor ${m.sgaAdvice.bestFactor}`, threshold: "Resize only if >10-20% est. DB time reduction", action: gain > 20 ? `Consider SGA_TARGET x${m.sgaAdvice.bestFactor} (verify host memory first).` : undefined });
  }
  if (e.latchHit != null)
    push({ checkId: "mem-latch", phase: "04 Memory", title: "Latch hit %", status: e.latchHit < 99 ? "warn" : "pass", observed: `${f(e.latchHit, 2)}%`, threshold: ">99%" });
  if (e.inMemorySort != null)
    push({ checkId: "io-temp", phase: "05 I/O", title: "In-memory sort %", status: e.inMemorySort < 95 ? "warn" : "pass", observed: `${f(e.inMemorySort, 2)}%`, threshold: ">95%" });

  // ---- Phase 06 concurrency
  const tx = ev(m, /^enq: TX - row lock contention$/i);
  if (tx)
    push({ checkId: "con-enq", phase: "06 Concurrency", title: "Row lock contention", status: (tx.pctDbTime ?? 0) > 5 ? "fail" : "warn", observed: `${f(tx.pctDbTime)}% DB time`, threshold: "Any material share is an application issue", action: "Use Segments by Row Lock Waits + ASH blocking_session to find the hot rows / long transactions." });
  const bb = ev(m, /^(buffer busy waits|read by other session)$/i);
  if (bb)
    push({ checkId: "con-buffer", phase: "06 Concurrency", title: bb.name, status: (bb.pctDbTime ?? 0) > 5 ? "fail" : "warn", observed: `${f(bb.pctDbTime)}% DB time`, threshold: "<5% DB time", action: "Hot blocks: check Segments by Buffer Busy Waits; consider hash partitioning / reverse key index." });
  const lib = ev(m, /^(library cache|cursor: pin S wait on X|cursor: mutex)/i);
  if (lib)
    push({ checkId: "con-segments", phase: "06 Concurrency", title: lib.name, status: "fail", observed: `${f(lib.pctDbTime)}% DB time`, threshold: "Should not be in top events", action: "Parsing/invalidation storm: check hard parse rate, DDL during load, high version counts." });

  return out;
}

function adviceForEvent(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("sequential read")) return "Index/single-block I/O: tune 'SQL ordered by Reads' first, then check storage latency.";
  if (n.includes("scattered read") || n.includes("direct path read")) return "Full scans: check plans for missing indexes / partition pruning.";
  if (n.includes("log file sync")) return "Commit latency: reduce commit frequency, check redo write latency.";
  if (n.includes("row lock")) return "Application row locking: find blocking sessions in ASH.";
  if (n.includes("library cache") || n.includes("cursor")) return "Parse/mutex contention: bind variables, avoid DDL in peak.";
  if (n.startsWith("gc ")) return "RAC cache fusion: check interconnect and application partitioning by instance.";
  if (n.includes("latch")) return "Latch contention: identify latch in Latch Sleep Breakdown.";
  if (n.includes("free buffer")) return "DBWR can't keep up: check write latency, buffer cache size.";
  if (n.includes("resmgr")) return "Resource Manager throttling: check plan directives / CPU_COUNT.";
  return "See Wait Event triage tab in the runbook.";
}

export function score(fs: Finding[]) {
  const c = { pass: 0, warn: 0, fail: 0, na: 0 };
  fs.forEach((x) => c[x.status]++);
  return c;
}
