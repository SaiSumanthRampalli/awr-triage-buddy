// Client-side AWR report parser. Accepts AWR HTML (awrrpt .html) or text (.txt/.lst) reports.
// Everything is normalised into rows of cells, then metrics are pulled by label / section.

export type WaitEvent = {
  name: string;
  waits: number | null;
  timeS: number | null;
  avgMs: number | null;
  pctDbTime: number | null;
  waitClass: string;
};

export type SqlHot = {
  sqlId: string;
  elapsedS: number | null;
  execs: number | null;
  perExecS: number | null;
  pctTotal: number | null;
  text: string;
};

export type AwrMetrics = {
  dbName?: string;
  instance?: string;
  version?: string;
  rac?: boolean;
  beginSnap?: string;
  endSnap?: string;
  elapsedMin?: number;
  dbTimeMin?: number;
  cpus?: number;
  load: Record<string, number>;
  eff: Record<string, number>;
  hostCpu: { user?: number; sys?: number; wio?: number; idle?: number };
  events: WaitEvent[];
  sqlElapsed: SqlHot[];
  sqlReads: SqlHot[];
  pgaCacheHit?: number;
  sgaAdvice?: { currentDbTime: number; bestDbTime: number; bestFactor: number };
  pgaOverallocAtCurrent?: number;
  sharedPoolPct?: { begin?: number; end?: number };
};

export type ParsedAwr = {
  fileName: string;
  format: "html" | "text";
  metrics: AwrMetrics;
  warnings: string[];
};

type Row = string[];

const clean = (s: string) => s.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

export function num(s: string | undefined | null): number | null {
  if (s == null) return null;
  const t = s.replace(/,/g, "").trim();
  const m = t.match(/^-?\d+(\.\d+)?(E[+-]?\d+)?/i);
  if (!m) return null;
  let v = parseFloat(m[0]);
  const rest = t.slice(m[0].length).trim().toUpperCase();
  if (rest === "K") v *= 1e3;
  else if (rest === "M") v *= 1e6;
  else if (rest === "G") v *= 1e9;
  else if (rest === "T") v *= 1e12;
  return isFinite(v) ? v : null;
}

/** Converts avg wait strings like "5.23", "1.2ms", "830us", "1.4s" to ms. */
function toMs(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  const v = num(t);
  if (v == null) return null;
  if (t.endsWith("us")) return v / 1000;
  if (t.endsWith("ms")) return v;
  if (t.endsWith("s")) return v * 1000;
  return v;
}

function htmlToRows(html: string): { rows: Row[]; headings: { idx: number; text: string }[] } {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const rows: Row[] = [];
  const headings: { idx: number; text: string }[] = [];
  const walker = doc.body ? doc.body.querySelectorAll("h1,h2,h3,h4,p,tr,pre") : [];
  walker.forEach((el) => {
    const tag = el.tagName.toLowerCase();
    if (tag === "tr") {
      const cells = Array.from(el.querySelectorAll("th,td")).map((c) => clean(c.textContent || ""));
      if (cells.some((c) => c)) rows.push(cells);
    } else if (tag === "pre") {
      (el.textContent || "").split(/\r?\n/).forEach((l) => {
        if (l.trim()) rows.push(splitTextLine(l));
      });
    } else {
      const t = clean(el.textContent || "");
      if (t && t.length < 120 && !el.closest("table")) {
        headings.push({ idx: rows.length, text: t });
        rows.push([t]);
      }
    }
  });
  return { rows, headings };
}

function splitTextLine(l: string): Row {
  return l
    .replace(/\u00a0/g, " ")
    .trim()
    .split(/\s{2,}|\t+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function textToRows(text: string): Row[] {
  return text.split(/\r?\n/).map(splitTextLine).filter((r) => r.length);
}

export function parseAwr(fileName: string, content: string): ParsedAwr {
  const isHtml = /<html|<table/i.test(content.slice(0, 5000));
  const warnings: string[] = [];
  const rows = isHtml ? htmlToRows(content).rows : textToRows(content);
  const joined = rows.map((r) => r.join("  ")).join("\n");

  const m: AwrMetrics = { load: {}, eff: {}, hostCpu: {}, events: [], sqlElapsed: [], sqlReads: [] };

  const rx = (re: RegExp) => {
    const r = joined.match(re);
    return r ? num(r[1]) ?? undefined : undefined;
  };

  m.elapsedMin = rx(/Elapsed:\s+([\d,.]+)\s*\(mins\)/i);
  m.dbTimeMin = rx(/DB Time:\s+([\d,.]+)\s*\(mins\)/i);

  // Header table: DB Name ... Release / RAC
  const hdrIdx = rows.findIndex((r) => r.some((c) => /^DB Name$/i.test(c)));
  if (hdrIdx >= 0 && rows[hdrIdx + 1]) {
    const h = rows[hdrIdx];
    const v = rows[hdrIdx + 1];
    const get = (re: RegExp) => {
      const i = h.findIndex((c) => re.test(c));
      return i >= 0 ? v[i] : undefined;
    };
    m.dbName = get(/^DB Name$/i);
    m.version = get(/^Release$/i);
    const rac = get(/^RAC$/i);
    if (rac) m.rac = /yes/i.test(rac);
    m.instance = get(/^Instance$/i);
  }
  const cpuIdx = rows.findIndex((r) => r.some((c) => /^CPUs$/i.test(c)));
  if (cpuIdx >= 0 && rows[cpuIdx + 1]) {
    const i = rows[cpuIdx].findIndex((c) => /^CPUs$/i.test(c));
    const v = num(rows[cpuIdx + 1][i]);
    if (v != null && v < 10000) m.cpus = v;
  }
  if (m.cpus == null) m.cpus = rx(/NUM_CPUS\s+([\d,]+)/i);

  const snap = (label: string) => {
    const r = rows.find((x) => x[0] && new RegExp(`^${label} Snap:?$`, "i").test(x[0]));
    return r ? r.slice(1, 3).join(" ") : undefined;
  };
  m.beginSnap = snap("Begin");
  m.endSnap = snap("End");

  // Load profile (per second column is the first number after label)
  const loadLabels: [string, RegExp][] = [
    ["dbTimePerSec", /^DB Time\(s\):?$/i],
    ["dbCpuPerSec", /^DB CPU\(s\):?$/i],
    ["redoPerSec", /^Redo size( \(bytes\))?:?$/i],
    ["logicalReadsPerSec", /^Logical reads?( \(blocks\))?:?$/i],
    ["physicalReadsPerSec", /^Physical reads?( \(blocks\))?:?$/i],
    ["userCallsPerSec", /^User calls:?$/i],
    ["parsesPerSec", /^Parses( \(SQL\))?:?$/i],
    ["hardParsesPerSec", /^Hard parses( \(SQL\))?:?$/i],
    ["executesPerSec", /^Executes( \(SQL\))?:?$/i],
    ["transactionsPerSec", /^Transactions:?$/i],
  ];
  for (const [key, re] of loadLabels) {
    const r = rows.find((x) => x[0] && re.test(x[0]));
    if (r) {
      const v = num(r[1]);
      if (v != null) m.load[key] = v;
    }
  }

  const effRx: [string, RegExp][] = [
    ["bufferNowait", /Buffer Nowait %:?\s+([\d.]+)/i],
    ["bufferHit", /Buffer\s+Hit\s+%:?\s+([\d.]+)/i],
    ["libraryHit", /Library Hit\s+%:?\s+([\d.]+)/i],
    ["softParse", /Soft Parse %:?\s+([\d.]+)/i],
    ["executeToParse", /Execute to Parse %:?\s+(-?[\d.]+)/i],
    ["latchHit", /Latch Hit %:?\s+([\d.]+)/i],
    ["parseCpuToElapsed", /Parse CPU to Parse Elapsd %:?\s+([\d.]+)/i],
    ["nonParseCpu", /% Non-Parse CPU:?\s+([\d.]+)/i],
    ["inMemorySort", /In-memory Sort %:?\s+([\d.]+)/i],
    ["redoNowait", /Redo NoWait %:?\s+([\d.]+)/i],
  ];
  for (const [k, re] of effRx) {
    const v = rx(re);
    if (v != null) m.eff[k] = v;
  }

  // Host CPU
  const hcIdx = rows.findIndex((r) => r.some((c) => /^%Idle$/i.test(c)) && r.some((c) => /%User/i.test(c)));
  if (hcIdx >= 0 && rows[hcIdx + 1]) {
    const h = rows[hcIdx];
    const v = rows[hcIdx + 1];
    // Text reports may lose leading load-average columns; align from the right.
    const off = v.length - h.length;
    const at = (re: RegExp) => {
      const i = h.findIndex((c) => re.test(c));
      return i >= 0 ? num(v[i + off]) ?? undefined : undefined;
    };
    m.hostCpu = { user: at(/^%User$/i), sys: at(/^%System$/i), wio: at(/^%WIO$/i), idle: at(/^%Idle$/i) };
  }

  // Top events
  const evStart = rows.findIndex((r) => /Top (10|5) (Foreground Events|Timed (Foreground )?Events)/i.test(r.join(" ")));
  if (evStart >= 0) {
    for (let i = evStart + 1; i < Math.min(rows.length, evStart + 40); i++) {
      const r = rows[i];
      const name = r[0];
      if (!name) continue;
      if (/^(Event|-+|~+)/i.test(name)) continue;
      if (/Wait Classes|Time Model|Host CPU|Foreground Wait Class|Wait Class/i.test(name) && m.events.length) break;
      if (name === "DB CPU" || /^CPU time$/i.test(name)) {
        const nums = r.slice(1).map(num).filter((x): x is number => x != null);
        m.events.push({ name: "DB CPU", waits: null, timeS: nums[0] ?? null, avgMs: null, pctDbTime: nums[nums.length - 1] ?? null, waitClass: "CPU" });
        continue;
      }
      if (r.length < 5 || num(r[1]) == null) {
        if (m.events.length >= 3) break;
        continue;
      }
      const last = r[r.length - 1];
      const hasClass = num(last) == null;
      m.events.push({
        name,
        waits: num(r[1]),
        timeS: num(r[2]),
        avgMs: toMs(r[3]),
        pctDbTime: num(r[4]),
        waitClass: hasClass ? last : "",
      });
      if (m.events.length >= 10) break;
    }
  } else warnings.push("Top foreground events section not found.");

  const sqlSection = (title: RegExp, out: SqlHot[]) => {
    const s = rows.findIndex((r) => r.length <= 2 && title.test(r.join(" ")));
    if (s < 0) return false;
    for (let i = s + 1; i < rows.length && out.length < 10; i++) {
      const r = rows[i];
      if (r.length <= 2 && /^SQL ordered by/i.test(r.join(" ")) && i > s + 1) break;
      const idIdx = r.findIndex((c) => /^[0-9a-z]{13}$/.test(c));
      if (idIdx < 0) continue;
      const nums = r.slice(0, idIdx).map(num);
      out.push({
        sqlId: r[idIdx],
        elapsedS: nums[0] ?? null,
        execs: nums[1] ?? null,
        perExecS: nums[2] ?? null,
        pctTotal: nums[3] ?? null,
        text: r.slice(idIdx + 1).join(" ").slice(0, 160),
      });
    }
    return true;
  };
  if (!sqlSection(/^SQL ordered by Elapsed Time/i, m.sqlElapsed)) warnings.push("'SQL ordered by Elapsed Time' not found.");
  sqlSection(/^SQL ordered by (Reads|Physical Reads)/i, m.sqlReads);

  // PGA cache hit
  const pgaIdx = rows.findIndex((r) => r.some((c) => /^PGA Cache Hit %$/i.test(c)));
  if (pgaIdx >= 0 && rows[pgaIdx + 1]) {
    const i = rows[pgaIdx].findIndex((c) => /^PGA Cache Hit %$/i.test(c));
    m.pgaCacheHit = num(rows[pgaIdx + 1][i]) ?? undefined;
  }
  if (m.pgaCacheHit == null) m.pgaCacheHit = rx(/PGA Cache Hit %:?\s+([\d.]+)/i);

  // SGA target advisory
  const sgaIdx = rows.findIndex((r) => r.length <= 2 && /^SGA Target Advisory/i.test(r.join(" ")));
  if (sgaIdx >= 0) {
    const pts: { f: number; t: number }[] = [];
    for (let i = sgaIdx + 1; i < Math.min(rows.length, sgaIdx + 40); i++) {
      const r = rows[i].map(num);
      if (r.length >= 3 && r[0] != null && r[1] != null && r[2] != null && r[1]! <= 4) pts.push({ f: r[1]!, t: r[2]! });
      else if (pts.length && rows[i].length <= 2) break;
    }
    const cur = pts.find((p) => Math.abs(p.f - 1) < 0.01);
    if (cur && pts.length) {
      const best = pts.reduce((a, b) => (b.t < a.t ? b : a));
      m.sgaAdvice = { currentDbTime: cur.t, bestDbTime: best.t, bestFactor: best.f };
    }
  }

  // PGA memory advisory overalloc at factor 1
  const pmaIdx = rows.findIndex((r) => r.length <= 2 && /^PGA Memory Advisory/i.test(r.join(" ")));
  if (pmaIdx >= 0) {
    for (let i = pmaIdx + 1; i < Math.min(rows.length, pmaIdx + 40); i++) {
      const r = rows[i].map(num);
      if (r.length >= 6 && r[1] != null && Math.abs(r[1]! - 1) < 0.01) {
        m.pgaOverallocAtCurrent = r[r.length - 1] ?? undefined;
        break;
      }
    }
  }

  if (m.elapsedMin == null) warnings.push("Header 'Elapsed' not found — is this an AWR report?");
  return { fileName, format: isHtml ? "html" : "text", metrics: m, warnings };
}
