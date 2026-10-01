export type CheckItem = {
  id: string;
  title: string;
  how: string;
  threshold: string;
  note?: string;
};

export type Phase = {
  id: string;
  code: string;
  title: string;
  goal: string;
  items: CheckItem[];
};

export const phases: Phase[] = [
  {
    id: "scope",
    code: "00",
    title: "Scope the snapshot window",
    goal: "Make sure the report describes the problem, not the average day.",
    items: [
      {
        id: "scope-window",
        title: "Window length is 15-60 minutes",
        how: "AWR header: Begin/End Snap times, Elapsed (min).",
        threshold: "Reject > 2h windows; peaks average away. Reject < 10 min; sampling noise.",
        note: "Never compare an AWR spanning a restart — check 'Instance Recovery' / startup time.",
      },
      {
        id: "scope-baseline",
        title: "A good-day baseline of the same window exists",
        how: "Same clock hours, same weekday, prior week.",
        threshold: "Every threshold below is only meaningful as a delta vs baseline.",
      },
      {
        id: "scope-rac",
        title: "RAC: per-instance reports pulled, not just global",
        how: "awrrpti.sql per instance + awrgrpt.sql for global.",
        threshold: "Skew > 30% in DB time between nodes = service/listener imbalance.",
      },
      {
        id: "scope-load",
        title: "Load profile compared to baseline",
        how: "Load Profile: DB time/s, executes/s, logical reads/s, hard parses/s.",
        threshold:
          "Hard parses > 5% of total parses, or > 50/s, = literal SQL / cursor problem.",
        note: "If load doubled and time tripled, you have a scaling limit, not a regression.",
      },
    ],
  },
  {
    id: "time",
    code: "01",
    title: "Establish the time budget",
    goal: "Decide whether this is a CPU problem, a wait problem, or neither.",
    items: [
      {
        id: "time-dbtime",
        title: "DB time vs elapsed x CPU count",
        how: "DB Time (min) / (Elapsed x #CPUs).",
        threshold: "> 1.0 means the instance wants more CPU than the box has.",
      },
      {
        id: "time-model",
        title: "Time Model Statistics reviewed top-down",
        how: "DB CPU, sql execute elapsed time, parse time elapsed, PL/SQL execution.",
        threshold:
          "DB CPU > 75% of DB time = CPU/SQL-efficiency path. < 40% = wait-event path.",
      },
      {
        id: "time-os",
        title: "OS stats sanity-checked",
        how: "Operating System Statistics: BUSY_TIME, IDLE_TIME, LOAD, physical memory.",
        threshold: "Host CPU busy > 80% sustained, or run queue > #cores, = host saturation.",
        note: "If host is busy but DB CPU is small, something else on the box is the thief.",
      },
    ],
  },
  {
    id: "waits",
    code: "02",
    title: "Top wait events triage",
    goal: "Name the bottleneck class before touching any SQL.",
    items: [
      {
        id: "wait-top5",
        title: "Top 10 Foreground Events ranked by % DB time",
        how: "Foreground Events section, sorted by Total Wait Time.",
        threshold: "Any single event > 25% of DB time is the headline. < 5% is noise.",
      },
      {
        id: "wait-avg",
        title: "Average wait per event checked, not just totals",
        how: "Avg wait (ms) column.",
        threshold:
          "db file sequential read > 10 ms, log file sync > 5 ms, log file parallel write > 3 ms.",
        note: "High count + low avg = SQL doing too much work. Low count + high avg = infrastructure.",
      },
      {
        id: "wait-class",
        title: "Wait class distribution mapped to an owner",
        how: "Wait Classes by Total Wait Time.",
        threshold:
          "User I/O -> SQL/storage. Concurrency -> app design. Commit -> redo/storage. Cluster -> interconnect. Configuration -> sizing.",
      },
      {
        id: "wait-bg",
        title: "Background events reviewed for checkpoint/archiver stalls",
        how: "Background Wait Events.",
        threshold:
          "Any 'log file switch (checkpoint incomplete)' or 'archiver' wait > 0 is actionable.",
      },
    ],
  },
  {
    id: "sql",
    code: "03",
    title: "SQL hotspot isolation",
    goal: "Find the few statements that own the time.",
    items: [
      {
        id: "sql-elapsed",
        title: "SQL ordered by Elapsed Time reviewed",
        how: "Top SQL section; note SQL_ID, %Total, Exec count, Elapsed/Exec.",
        threshold: "Any SQL_ID > 10% of DB time is a tuning candidate; > 25% is the target.",
      },
      {
        id: "sql-class",
        title: "Each top SQL classified",
        how: "Compare Elapsed/Exec vs executions.",
        threshold:
          "Few execs, huge elapsed = plan problem. Many execs, small elapsed = call-rate / app loop problem.",
      },
      {
        id: "sql-reads",
        title: "SQL ordered by Gets and Reads cross-checked",
        how: "Buffer Gets per exec, Physical Reads per exec.",
        threshold:
          "Gets/row > 100 suggests a missing index or bad join order. Gets/exec > 1M on an OLTP call is a defect.",
      },
      {
        id: "sql-plan",
        title: "Plan stability checked for the top SQL_IDs",
        how: "DBA_HIST_SQLSTAT by PLAN_HASH_VALUE across snapshots.",
        threshold: "More than one plan hash in the window with >2x elapsed difference = plan flip.",
        note: "Plan flip is a different fix path than a genuinely expensive statement.",
      },
      {
        id: "sql-parse",
        title: "SQL ordered by Parse Calls and Version Count reviewed",
        how: "Top SQL by Parse Calls; V$SQL_SHARED_CURSOR for the offender.",
        threshold: "Version count > 20 for one SQL = cursor sharing problem.",
      },
    ],
  },
  {
    id: "memory",
    code: "04",
    title: "Memory advisories",
    goal: "Let the advisories size the SGA/PGA, never intuition.",
    items: [
      {
        id: "mem-buffer",
        title: "Buffer Pool Advisory read for the knee of the curve",
        how: "Est Phys Read Factor vs Size Factor.",
        threshold:
          "Grow only if a larger size cuts estimated reads > 10%. Below that, cache is not the problem.",
      },
      {
        id: "mem-shared",
        title: "Shared Pool Advisory checked",
        how: "Est LC Time Saved / Est LC Load Time.",
        threshold:
          "Grow if estimated parse time saved > 10%. Flat curve + high hard parse = bind variables, not memory.",
      },
      {
        id: "mem-pga",
        title: "PGA Advisory and workarea histogram checked",
        how: "PGA Aggr Target Advice; PGA Memory Advisory; Process Memory Summary.",
        threshold:
          "Target cache hit % < 90%, or any multi-pass executions > 0, means PGA is undersized.",
        note: "One-pass is tolerable for batch, never for OLTP sorts.",
      },
      {
        id: "mem-sga",
        title: "Resize operations reviewed for thrashing",
        how: "Memory Dynamic Components / Memory Resize Operations.",
        threshold: "Repeated grow/shrink of the same component = set explicit minimums.",
      },
      {
        id: "mem-latch",
        title: "Latch and mutex activity scanned",
        how: "Latch Sleep Breakdown; 'library cache: mutex X', 'cursor: pin S'.",
        threshold: "Sleeps/Miss > 1 or mutex waits in top 10 = concurrency, not sizing.",
      },
    ],
  },
  {
    id: "io",
    code: "05",
    title: "I/O, redo and undo",
    goal: "Separate storage latency from SQL volume.",
    items: [
      {
        id: "io-tablespace",
        title: "Tablespace / file I/O stats reviewed",
        how: "IOStat by Function and Tablespace IO Stats.",
        threshold: "Av Rd(ms) > 10 on flash, > 20 on spinning disk = storage-side issue.",
      },
      {
        id: "io-redo",
        title: "Redo generation compared with baseline",
        how: "Load Profile: Redo size/s; log switches per hour.",
        threshold: "More than 4-5 log switches per hour = undersized redo logs.",
      },
      {
        id: "io-undo",
        title: "Undo segment summary checked",
        how: "Undo Segment Summary: ORA-01555 count, max query length.",
        threshold: "Any snapshot-too-old count > 0 = undo retention vs longest query mismatch.",
      },
      {
        id: "io-temp",
        title: "Temp usage checked against sorts",
        how: "Instance Activity: 'sorts (disk)' vs 'sorts (memory)'.",
        threshold: "Disk sorts > 1% of total sorts = PGA or SQL shape problem.",
      },
    ],
  },
  {
    id: "concurrency",
    code: "06",
    title: "Concurrency and contention",
    goal: "Catch serialization that no amount of hardware will fix.",
    items: [
      {
        id: "con-enq",
        title: "Enqueue activity reviewed by type",
        how: "Enqueue Activity section: TX, TM, HW, SQ, CF.",
        threshold:
          "enq: TX - row lock contention in top 5 = application locking. enq: HW / SQ = segment or sequence hotspot.",
      },
      {
        id: "con-buffer",
        title: "Buffer busy and block contention located",
        how: "Segments by Buffer Busy Waits; 'buffer busy waits', 'gc buffer busy'.",
        threshold: "One segment owning > 30% of buffer busy waits = hot block / index right-hand growth.",
      },
      {
        id: "con-segments",
        title: "Segment statistics reviewed for all five rankings",
        how: "Segments by Logical Reads, Physical Reads, Row Lock Waits, ITL Waits, Buffer Busy Waits.",
        threshold: "ITL waits > 0 on a hot table = raise INITRANS.",
      },
    ],
  },
  {
    id: "close",
    code: "07",
    title: "Conclude and record",
    goal: "One bottleneck, one change, one measurement.",
    items: [
      {
        id: "close-single",
        title: "A single dominant bottleneck is named",
        how: "State it as: '<event or SQL_ID> accounts for N% of DB time'.",
        threshold: "If nothing exceeds 20%, the system is balanced — stop tuning, add capacity or reduce calls.",
      },
      {
        id: "close-change",
        title: "One change proposed with an expected gain",
        how: "Predict the new %DB time before applying.",
        threshold: "Expected gain < 10% of DB time is not worth a production change.",
      },
      {
        id: "close-verify",
        title: "Post-change AWR captured over the same window",
        how: "Same hours, same weekday, same workload shape.",
        threshold: "Confirm the target event/SQL dropped and nothing new entered the top 5.",
      },
    ],
  },
];

export type TriageRow = {
  signal: string;
  likelyCause: string;
  threshold: string;
  action: string;
};

export const waitTriage: TriageRow[] = [
  {
    signal: "db file sequential read",
    likelyCause: "Index-driven single-block reads; often a bad plan, not slow disk",
    threshold: "Avg > 10 ms, or > 25% DB time",
    action: "Tune the top SQL by physical reads first; only then look at storage latency",
  },
  {
    signal: "db file scattered read",
    likelyCause: "Full scans",
    threshold: "Avg > 20 ms or rising vs baseline",
    action: "Check for missing index, stale stats, or an intentionally correct full scan",
  },
  {
    signal: "direct path read / temp",
    likelyCause: "Serial direct reads, large sorts/hash spills",
    threshold: "Any significant temp traffic in OLTP",
    action: "Raise PGA_AGGREGATE_TARGET; reduce sort/hash volume in SQL",
  },
  {
    signal: "log file sync",
    likelyCause: "Commit latency",
    threshold: "Avg > 5 ms",
    action: "Faster redo storage, or batch commits — check commits/s in Load Profile",
  },
  {
    signal: "log file switch (checkpoint incomplete)",
    likelyCause: "Redo logs too small or too few",
    threshold: "Any occurrence",
    action: "Resize redo so switches are at most 4-5 per hour",
  },
  {
    signal: "buffer busy waits",
    likelyCause: "Hot block, often an index leaf or freelist",
    threshold: "Top 5, or one segment > 30% of the waits",
    action: "Hash/reverse-key index, more freelists or ASSM, partition the hotspot",
  },
  {
    signal: "latch: cache buffers chains",
    likelyCause: "Extreme logical reads on few blocks",
    threshold: "Top 5 with high logical reads/s",
    action: "Reduce buffer gets in the top SQL — this is a SQL fix, not a memory fix",
  },
  {
    signal: "library cache: mutex X / cursor: pin S",
    likelyCause: "Parsing and cursor contention",
    threshold: "Top 5, or version count > 20",
    action: "Use bind variables, cut hard parses, check for excessive child cursors",
  },
  {
    signal: "enq: TX - row lock contention",
    likelyCause: "Application-level locking",
    threshold: "Any presence in top 5",
    action: "Shorten transactions; find blocker via ASH, not AWR alone",
  },
  {
    signal: "gc cr/current block busy (RAC)",
    likelyCause: "Interconnect or block shipping pressure",
    threshold: "Avg > 5 ms",
    action: "Service partitioning by workload; verify private interconnect health",
  },
  {
    signal: "read by other session",
    likelyCause: "Many sessions queueing on the same block read",
    threshold: "Top 10",
    action: "Same fix as buffer busy: reduce concurrency on the hot segment",
  },
  {
    signal: "resmgr: cpu quantum",
    likelyCause: "Resource Manager throttling",
    threshold: "Any presence",
    action: "Review the active resource plan before blaming the SQL",
  },
];

export type TuningPath = {
  symptom: string;
  steps: string[];
};

export const tuningPaths: TuningPath[] = [
  {
    symptom: "Plan flip — same SQL, new plan, worse time",
    steps: [
      "Confirm multiple PLAN_HASH_VALUEs in DBA_HIST_SQLSTAT for the window",
      "Compare the good and bad plans with DBMS_XPLAN.DISPLAY_AWR",
      "Check for stats gathered or bind peeking between the snapshots",
      "Short term: pin the good plan with a SQL Plan Baseline",
      "Long term: fix the cause — stale stats, missing histogram, or skewed binds",
    ],
  },
  {
    symptom: "Genuinely expensive SQL — high gets per row",
    steps: [
      "Get the real plan: DBMS_XPLAN.DISPLAY_CURSOR with ALLSTATS LAST",
      "Find the step where estimated and actual rows diverge by more than 10x",
      "Fix the cardinality: stats, histogram, extended stats, or rewrite the predicate",
      "Only then consider an index; validate with a test execution, not a cost number",
    ],
  },
  {
    symptom: "High hard parse rate",
    steps: [
      "Confirm hard parses/s and parse time elapsed in the Time Model",
      "Find literal SQL via FORCE_MATCHING_SIGNATURE grouping in V$SQL",
      "Fix in the application with bind variables",
      "CURSOR_SHARING=FORCE only as a temporary containment measure",
    ],
  },
  {
    symptom: "Storage latency, not SQL volume",
    steps: [
      "Confirm avg read latency in Tablespace IO Stats and IOStat by Function",
      "Correlate with OS-level latency over the same window",
      "If DB-side volume is flat and latency rose, escalate to storage",
      "If volume rose, it is a SQL problem wearing a storage costume",
    ],
  },
  {
    symptom: "PGA pressure — multi-pass work areas",
    steps: [
      "Check PGA Aggr Target Advice for the size with zero multi-pass",
      "Verify host memory can absorb the new target plus SGA",
      "Raise PGA_AGGREGATE_TARGET; re-measure disk sorts next window",
      "If a single SQL drives it, reduce its sort/hash volume instead",
    ],
  },
];

export const sqlSnippets: { title: string; sql: string }[] = [
  {
    title: "Find snapshot IDs for the window",
    sql: `SELECT snap_id, begin_interval_time, end_interval_time
FROM   dba_hist_snapshot
WHERE  begin_interval_time > SYSDATE - 1
ORDER  BY snap_id;`,
  },
  {
    title: "Top SQL by DB time between two snaps",
    sql: `SELECT sql_id, plan_hash_value,
       SUM(elapsed_time_delta)/1e6      AS elapsed_s,
       SUM(executions_delta)            AS execs,
       SUM(buffer_gets_delta)           AS gets,
       SUM(disk_reads_delta)            AS reads
FROM   dba_hist_sqlstat
WHERE  snap_id BETWEEN :b AND :e
GROUP  BY sql_id, plan_hash_value
ORDER  BY elapsed_s DESC FETCH FIRST 15 ROWS ONLY;`,
  },
  {
    title: "Detect a plan flip for one SQL_ID",
    sql: `SELECT snap_id, plan_hash_value, executions_delta,
       ROUND(elapsed_time_delta/NULLIF(executions_delta,0)/1000,2) AS ms_per_exec
FROM   dba_hist_sqlstat
WHERE  sql_id = :sql_id
ORDER  BY snap_id;`,
  },
  {
    title: "Show the historical plan",
    sql: `SELECT * FROM TABLE(
  DBMS_XPLAN.DISPLAY_AWR(:sql_id, :plan_hash_value, NULL, 'ADVANCED'));`,
  },
  {
    title: "Real execution statistics for a live cursor",
    sql: `SELECT * FROM TABLE(
  DBMS_XPLAN.DISPLAY_CURSOR(:sql_id, NULL, 'ALLSTATS LAST +PEEKED_BINDS'));`,
  },
  {
    title: "Wait-event profile from ASH for the same window",
    sql: `SELECT NVL(event,'ON CPU') AS event, wait_class, COUNT(*) AS samples
FROM   dba_hist_active_sess_history
WHERE  snap_id BETWEEN :b AND :e
GROUP  BY NVL(event,'ON CPU'), wait_class
ORDER  BY samples DESC FETCH FIRST 15 ROWS ONLY;`,
  },
  {
    title: "Cursor version count offenders",
    sql: `SELECT sql_id, version_count, executions, SUBSTR(sql_text,1,80) AS txt
FROM   v$sqlarea
WHERE  version_count > 20
ORDER  BY version_count DESC;`,
  },
  {
    title: "Pin a known-good plan as a baseline",
    sql: `DECLARE n PLS_INTEGER;
BEGIN
  n := DBMS_SPM.LOAD_PLANS_FROM_AWR(
         begin_snap => :b, end_snap => :e,
         basic_filter => q'[sql_id = ':sql_id']');
END;
/`,
  },
];

export const redFlags: string[] = [
  "Tuning the top wait event when it is under 10% of DB time.",
  "Reading hit ratios. Buffer cache hit ratio of 99% proves nothing.",
  "Comparing an AWR against a report from a different workload shape.",
  "Changing more than one parameter between measurements.",
  "Sizing the SGA by feel instead of by the advisory curve.",
  "Adding an index without checking which plan step actually hurts.",
  "Ignoring Avg Wait (ms) and ranking purely on total waits.",
  "Treating an AWR over a window containing an instance restart as valid.",
];
