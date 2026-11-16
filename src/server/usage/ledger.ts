import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type UsageStage = "llm_generation" | "llm_verification" | "stt" | "tts";
export type UsageOperation = "turn" | "transcription" | "speech";
export interface UsageUnits {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  audioMilliseconds?: number;
  characters?: number;
}
export interface ProviderPlan {
  mode: "free" | "paid";
  /** A conservative upper bound, including minimum billing and extra tokens. */
  maxCostMicros: number;
  rates?: Partial<Record<keyof UsageUnits, number>>;
}
export interface UsagePolicy {
  allowPaid: boolean;
  dailyBudgetMicros: number;
  monthlyBudgetMicros: number;
  plans: Record<string, ProviderPlan>;
  maxConcurrent: number;
  callsPerMinute: number;
  sessionPerMinute: number;
  maxCompletedTurns: number;
}
export interface CallOptions {
  stage: UsageStage;
  provider: string;
  model: string;
  units?: UsageUnits;
}
const USAGE_ERROR = Symbol.for("sejong.usage.error");
export class UsageError extends Error {
  readonly [USAGE_ERROR] = true;
  readonly retryable = false;
  readonly httpStatus: number;
  readonly code: "LIMIT_EXCEEDED" | "UNAVAILABLE" | "REQUEST_CONFLICT";
  constructor(code: "LIMIT_EXCEEDED" | "UNAVAILABLE" | "REQUEST_CONFLICT") {
    super(code === "LIMIT_EXCEEDED" ? "설정한 사용 한도에 도달했습니다." : "사용 한도를 확인할 수 없습니다.");
    this.name = "UsageError";
    this.code = code;
    this.httpStatus = code === "LIMIT_EXCEEDED" ? 429 : code === "REQUEST_CONFLICT" ? 409 : 503;
  }
}
/** The cached ledger can retain a previous class instance across Next hot reload. */
export function isUsageError(error: unknown): error is UsageError {
  return error instanceof Error && USAGE_ERROR in error && error[USAGE_ERROR] === true &&
    "code" in error && ["LIMIT_EXCEEDED", "UNAVAILABLE", "REQUEST_CONFLICT"].includes(String(error.code));
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function period(now: number) {
  const koreanDate = new Date(now + 9 * 60 * 60 * 1000).toISOString();
  return { day: koreanDate.slice(0, 10), month: koreanDate.slice(0, 7) };
}
function validUnits(units: UsageUnits): UsageUnits {
  const allowed = ["inputTokens", "outputTokens", "totalTokens", "audioMilliseconds", "characters"];
  for (const [key, value] of Object.entries(units)) {
    if (!allowed.includes(key) || !Number.isSafeInteger(value) || value < 0) throw new UsageError("UNAVAILABLE");
  }
  return units;
}

/** Single-host durable ledger. Every admission and debit uses the same SQLite transaction. */
export class UsageLedger {
  private readonly db: DatabaseSync;
  readonly path: string;
  readonly policy: UsagePolicy;
  private readonly now: () => number;
  constructor(path: string, policy: UsagePolicy, now = Date.now) {
    this.path = path; this.policy = policy; this.now = now;
    for (const [name, value] of Object.entries(policy)) {
      if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0 ||
          (!["dailyBudgetMicros", "monthlyBudgetMicros"].includes(name) && value === 0))) throw new UsageError("UNAVAILABLE");
    }
    for (const plan of Object.values(policy.plans)) {
      if (!["free", "paid"].includes(plan.mode) || !Number.isSafeInteger(plan.maxCostMicros) || plan.maxCostMicros < 0 ||
          (plan.mode === "free" && plan.maxCostMicros !== 0) || (plan.mode === "paid" && plan.maxCostMicros === 0)) throw new UsageError("UNAVAILABLE");
      for (const value of Object.values(plan.rates ?? {})) {
        if (!Number.isFinite(value) || value < 0) throw new UsageError("UNAVAILABLE");
      }
    }
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS calls (
        id TEXT PRIMARY KEY, stage TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL,
        started INTEGER NOT NULL, day TEXT NOT NULL, month TEXT NOT NULL, mode TEXT NOT NULL,
        reserved INTEGER NOT NULL, cost INTEGER NOT NULL, status TEXT NOT NULL, units TEXT NOT NULL,
        latency INTEGER, uncertain INTEGER NOT NULL DEFAULT 1, pid INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS calls_month ON calls(month);
      CREATE TABLE IF NOT EXISTS session_requests (
        id TEXT PRIMARY KEY, session TEXT NOT NULL, operation TEXT NOT NULL,
        started INTEGER NOT NULL, status TEXT NOT NULL, pid INTEGER NOT NULL
      ); CREATE INDEX IF NOT EXISTS session_lookup ON session_requests(session, operation, started);`);
    this.transaction(() => this.recoverDeadProcesses());
  }
  private recoverDeadProcesses() {
    // Same-host crash recovery: release only dead-process slots, keeping all reserved costs.
    for (const row of this.db.prepare("SELECT DISTINCT pid FROM calls WHERE status='reserved' UNION SELECT DISTINCT pid FROM session_requests WHERE status='processing'").all()) {
      try { process.kill(Number(row.pid), 0); }
      catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
          this.db.prepare("UPDATE calls SET status='failed' WHERE pid=? AND status='reserved'").run(row.pid);
          this.db.prepare("UPDATE session_requests SET status='failed' WHERE pid=? AND status='processing'").run(row.pid);
        }
      }
    }
  }
  close() { this.db.close(); }
  private transaction<T>(work: () => T): T {
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try { const result = work(); this.db.exec("COMMIT"); return result; }
      catch (error) { this.db.exec("ROLLBACK"); throw error; }
    } catch (error) { throw isUsageError(error) ? error : new UsageError("UNAVAILABLE"); }
  }
  private count(sql: string, ...params: (string | number)[]) {
    return Number(this.db.prepare(sql).get(...params)?.value ?? 0);
  }
  reserve(options: CallOptions): string {
    return this.transaction(() => {
      this.recoverDeadProcesses();
      const plan = this.policy.plans[`${options.provider}:${options.stage}`];
      if (!plan || (plan.mode === "paid" && !this.policy.allowPaid)) throw new UsageError("UNAVAILABLE");
      if (!/^[a-z0-9_-]{1,80}$/.test(options.provider) || !options.model || options.model.length > 120) throw new UsageError("UNAVAILABLE");
      const now = this.now(); const { day, month } = period(now);
      if (this.count("SELECT COUNT(*) value FROM calls WHERE stage=? AND status='reserved'", options.stage) >= this.policy.maxConcurrent ||
          this.count("SELECT COUNT(*) value FROM calls WHERE stage=? AND started>?", options.stage, now - 60_000) >= this.policy.callsPerMinute) throw new UsageError("LIMIT_EXCEEDED");
      if (plan.mode === "paid") {
        // A reported overrun means the ceiling is unsafe. Do not make further paid calls.
        if (this.count("SELECT COUNT(*) value FROM calls WHERE cost>reserved") > 0 ||
            this.count("SELECT COALESCE(SUM(cost),0) value FROM calls WHERE day=?", day) + plan.maxCostMicros > this.policy.dailyBudgetMicros ||
            this.count("SELECT COALESCE(SUM(cost),0) value FROM calls WHERE month=?", month) + plan.maxCostMicros > this.policy.monthlyBudgetMicros) throw new UsageError("LIMIT_EXCEEDED");
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO calls(id,stage,provider,model,started,day,month,mode,reserved,cost,status,units,pid) VALUES(?,?,?,?,?,?,?,?,?,?,'reserved',?,?)")
        .run(id, options.stage, options.provider, options.model, now, day, month, plan.mode, plan.maxCostMicros, plan.maxCostMicros, JSON.stringify(validUnits(options.units ?? {})), process.pid);
      return id;
    });
  }
  finish(id: string, status: "completed" | "failed" | "cancelled", reported: UsageUnits = {}) {
    const invalidReport = this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM calls WHERE id=?").get(id);
      if (!row || row.status !== "reserved") return false; // Settlement is exactly once.
      const failSettlement = () => {
        // Commit the failure before reporting bad usage. Throwing inside this
        // transaction would roll back the slot release and block future calls.
        this.db.prepare("UPDATE calls SET status='failed', cost=reserved, latency=?, uncertain=1 WHERE id=?")
          .run(Math.max(0, this.now() - Number(row.started)), id);
        return true;
      };
      const plan = this.policy.plans[`${row.provider}:${row.stage}`];
      let units: UsageUnits;
      try { units = validUnits({ ...JSON.parse(String(row.units)), ...reported }); }
      catch { return failSettlement(); }
      const rates = plan?.rates;
      const known = row.mode === "free" || (status === "completed" && rates && Object.keys(rates).length > 0 &&
        Object.keys(rates).every((key) => units[key as keyof UsageUnits] !== undefined));
      const calculated = row.mode === "free" ? 0 : known ? Math.ceil(Object.entries(rates!).reduce((sum, [unit, rate]) => sum + units[unit as keyof UsageUnits]! * rate!, 0)) : Number(row.reserved);
      if (!Number.isSafeInteger(calculated)) return failSettlement();
      this.db.prepare("UPDATE calls SET status=?, cost=?, units=?, latency=?, uncertain=? WHERE id=?")
        .run(status, calculated, JSON.stringify(units), Math.max(0, this.now() - Number(row.started)), known ? 0 : 1, id);
      return false;
    });
    if (invalidReport) throw new UsageError("UNAVAILABLE");
  }
  beginSession(sessionId: string, operation: UsageOperation, requestId: string): string {
    return this.transaction(() => {
      this.recoverDeadProcesses();
      if (!sessionId || !requestId || sessionId.length > 128 || requestId.length > 128) throw new UsageError("UNAVAILABLE");
      const session = hash(sessionId); const id = hash(`${sessionId}:${operation}:${requestId}`); const now = this.now();
      if (this.db.prepare("SELECT id FROM session_requests WHERE id=?").get(id)) throw new UsageError("REQUEST_CONFLICT");
      if (this.count("SELECT COUNT(*) value FROM session_requests WHERE session=? AND operation=? AND status='processing'", session, operation) >= 1 ||
          this.count("SELECT COUNT(*) value FROM session_requests WHERE session=? AND operation=? AND started>?", session, operation, now - 60_000) >= this.policy.sessionPerMinute ||
          (operation === "turn" && this.count("SELECT COUNT(*) value FROM session_requests WHERE session=? AND operation='turn' AND status='completed'", session) >= this.policy.maxCompletedTurns)) throw new UsageError("LIMIT_EXCEEDED");
      this.db.prepare("INSERT INTO session_requests VALUES(?,?,?,?,'processing',?)").run(id, session, operation, now, process.pid);
      return id;
    });
  }
  finishSession(id: string, completed: boolean) {
    this.transaction(() => { this.db.prepare("UPDATE session_requests SET status=? WHERE id=? AND status='processing'").run(completed ? "completed" : "failed", id); });
  }
  snapshot() {
    try {
      const { day, month } = period(this.now());
      return {
        day, month,
        dailyCostMicros: this.count("SELECT COALESCE(SUM(cost),0) value FROM calls WHERE day=?", day),
        monthlyCostMicros: this.count("SELECT COALESCE(SUM(cost),0) value FROM calls WHERE month=?", month),
        calls: this.db.prepare("SELECT stage,provider,model,started,mode,cost,status,units,latency,uncertain FROM calls ORDER BY started").all(),
      };
    } catch { throw new UsageError("UNAVAILABLE"); }
  }
}
