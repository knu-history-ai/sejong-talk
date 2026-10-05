import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { UsageLedger, UsageError } from "../src/server/usage/ledger.ts";
import { readUsagePolicy, runMeteredCall } from "../src/server/usage/runtime.ts";
import { RequestCoordinator } from "../src/server/requests/index.ts";
import { runCoordinatedSejongTurn } from "../src/server/ai/turn-runner.ts";

const call = { stage: "llm_generation", provider: "example", model: "mock-v1", units: { inputTokens: 20 } };
function policy(overrides = {}) {
  return { allowPaid: true, dailyBudgetMicros: 100, monthlyBudgetMicros: 100,
    plans: { "example:llm_generation": { mode: "paid", maxCostMicros: 60 } },
    maxConcurrent: 5, callsPerMinute: 60, sessionPerMinute: 6, maxCompletedTurns: 30, ...overrides };
}
function fixture(t, overrides = {}, now) {
  const dir = mkdtempSync(join(tmpdir(), "sejong-usage-"));
  const db = join(dir, "usage.sqlite"); const ledger = new UsageLedger(db, policy(overrides), now);
  t.after(() => { try { ledger.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return { ledger, db };
}
function fails(code) { return (error) => error instanceof UsageError && error.code === code; }

test("reservation atomically prevents exceeding the daily budget; restart preserves failure/cancellation cost", (t) => {
  const { ledger, db } = fixture(t);
  const id = ledger.reserve(call);
  assert.throws(() => ledger.reserve(call), fails("LIMIT_EXCEEDED"));
  ledger.finish(id, "cancelled"); ledger.finish(id, "completed", { outputTokens: 0 });
  ledger.close(); const reopened = new UsageLedger(db, policy());
  assert.equal(reopened.snapshot().monthlyCostMicros, 60);
  assert.equal(reopened.snapshot().calls[0].status, "cancelled");
  assert.throws(() => reopened.reserve(call), fails("LIMIT_EXCEEDED")); reopened.close();
});

test("separate database connections cannot race the remaining budget", (t) => {
  const { ledger, db } = fixture(t); const second = new UsageLedger(db, policy());
  ledger.reserve(call); assert.throws(() => second.reserve(call), fails("LIMIT_EXCEEDED")); second.close();
});

test("actual configured unit rates reconcile once; unknown failures retain the ceiling", (t) => {
  const { ledger } = fixture(t, { plans: { "example:llm_generation": { mode: "paid", maxCostMicros: 60, rates: { inputTokens: 1, outputTokens: 2 } } } });
  const first = ledger.reserve(call); ledger.finish(first, "completed", { outputTokens: 10 }); ledger.finish(first, "completed", { outputTokens: 0 });
  assert.equal(ledger.snapshot().dailyCostMicros, 40);
  const second = ledger.reserve(call); ledger.finish(second, "failed");
  assert.equal(ledger.snapshot().monthlyCostMicros, 100);
  assert.throws(() => ledger.reserve(call), fails("LIMIT_EXCEEDED"));
});

test("day resets cannot bypass the shared monthly budget or changing sessions", (t) => {
  let now = Date.UTC(2026, 9, 6); const { ledger } = fixture(t, {}, () => now);
  ledger.finish(ledger.reserve(call), "failed"); now += 86_400_000;
  assert.equal(ledger.snapshot().dailyCostMicros, 0);
  const request = ledger.beginSession("new-session", "turn", "new-request"); ledger.finishSession(request, true);
  assert.throws(() => ledger.reserve(call), fails("LIMIT_EXCEEDED"));
});

test("unexpected billing above a configured ceiling blocks all further paid requests", (t) => {
  const { ledger } = fixture(t, { dailyBudgetMicros: 1000, monthlyBudgetMicros: 1000,
    plans: { "example:llm_generation": { mode: "paid", maxCostMicros: 60, rates: { inputTokens: 10 } } } });
  ledger.finish(ledger.reserve(call), "completed"); assert.equal(ledger.snapshot().dailyCostMicros, 200);
  assert.throws(() => ledger.reserve(call), fails("LIMIT_EXCEEDED"));
});

test("unknown plans, paid service policy and unreadable ledger stop before network work", async (t) => {
  const { ledger } = fixture(t, { allowPaid: false });
  assert.throws(() => ledger.reserve(call), fails("UNAVAILABLE"));
  assert.throws(() => ledger.reserve({ ...call, provider: "unconfirmed" }), fails("UNAVAILABLE"));
  globalThis.sejongUsageLedger = ledger; t.after(() => delete globalThis.sejongUsageLedger);
  let fetched = 0;
  await assert.rejects(runMeteredCall(call, async () => { fetched++; }), fails("UNAVAILABLE"));
  ledger.close();
  await assert.rejects(runMeteredCall(call, async () => { fetched++; }), fails("UNAVAILABLE"));
  assert.equal(fetched, 0);
});

test("production environment configuration cannot turn paid APIs on", () => {
  assert.equal(readUsagePolicy({ USAGE_ALLOW_PAID: "true" }).allowPaid, false);
  assert.deepEqual(readUsagePolicy({}).plans, {});
  assert.throws(() => readUsagePolicy({ USAGE_PROVIDER_PLANS: "[]" }), fails("UNAVAILABLE"));
  assert.throws(() => new UsageLedger(":memory:", readUsagePolicy({ USAGE_MAX_CONCURRENT: "x" })), fails("UNAVAILABLE"));
});

test("provider stage quotas are independent and the last concurrency slot is atomic", (t) => {
  const plans = Object.fromEntries(["llm_generation", "llm_verification", "stt", "tts"].map((stage) => [`example:${stage}`, { mode: "free", maxCostMicros: 0 }]));
  let now = Date.UTC(2026, 9, 6); const { ledger, db } = fixture(t, { plans, maxConcurrent: 1, callsPerMinute: 1 }, () => now);
  const other = new UsageLedger(db, policy({ plans, maxConcurrent: 1, callsPerMinute: 1 }), () => now);
  const id = ledger.reserve(call); assert.throws(() => other.reserve(call), fails("LIMIT_EXCEEDED"));
  for (const stage of ["llm_verification", "stt", "tts"]) ledger.finish(ledger.reserve({ ...call, stage }), "completed");
  ledger.finish(id, "failed"); assert.throws(() => other.reserve(call), fails("LIMIT_EXCEEDED"));
  now += 60_001; other.finish(other.reserve(call), "completed"); other.close();
});

test("session gates enforce one concurrent request per operation, six per minute and thirty completed questions", (t) => {
  let now = Date.UTC(2026, 9, 6); const { ledger } = fixture(t, {}, () => now);
  const id = ledger.beginSession("s", "turn", "first");
  assert.throws(() => ledger.beginSession("s", "turn", "parallel"), fails("LIMIT_EXCEEDED"));
  const stt = ledger.beginSession("s", "transcription", "audio"); ledger.finishSession(stt, false); ledger.finishSession(id, true);
  assert.throws(() => ledger.beginSession("s", "turn", "first"), fails("REQUEST_CONFLICT"));
  for (let i = 1; i < 6; i++) ledger.finishSession(ledger.beginSession("s", "turn", `r${i}`), true);
  assert.throws(() => ledger.beginSession("s", "turn", "seventh"), fails("LIMIT_EXCEEDED"));
  for (let i = 6; i < 30; i++) { now += 61_000; ledger.finishSession(ledger.beginSession("s", "turn", `r${i}`), true); }
  now += 61_000; assert.throws(() => ledger.beginSession("s", "turn", "thirtyfirst"), fails("LIMIT_EXCEEDED"));
});

function approved(requestId) { return { requestId, operation: "turn", status: "approved", answer: { answerId: requestId, text: "안녕", kind: "conversation", factIds: [], sources: [], personaVersion: "v1", contentVersion: "v1" } }; }
test("coordinator duplicate requests reuse the same quota and generation", async (t) => {
  const { ledger } = fixture(t, { maxCompletedTurns: 1 }); const coordinator = new RequestCoordinator(); let called = 0;
  const options = { coordinator, request: { requestId: "dedup", text: "안녕" }, usage: { ledger, sessionId: "s" },
    generateTurn: async () => { called++; return approved("dedup"); } };
  const result = await Promise.all([runCoordinatedSejongTurn(options), runCoordinatedSejongTurn(options)]);
  assert.equal(called, 1); assert.equal(result[0].status, "approved");
  const next = await runCoordinatedSejongTurn({ ...options, request: { requestId: "next", text: "안녕" } });
  assert.equal(next.code, "LIMIT_EXCEEDED"); assert.equal(called, 1);
});

test("cancellation holds the slot until a non-cooperating provider actually stops", async (t) => {
  const { ledger } = fixture(t); const coordinator = new RequestCoordinator(); let release; let notify;
  const started = new Promise((r) => { notify = r; });
  const options = { coordinator, request: { requestId: "cancelled", text: "안녕" }, usage: { ledger, sessionId: "s" },
    generateTurn: () => new Promise((r) => { release = r; notify(); }) };
  const pending = runCoordinatedSejongTurn(options); await started; coordinator.cancel("cancelled");
  assert.equal((await pending).status, "cancelled");
  assert.throws(() => ledger.beginSession("s", "turn", "too-soon"), fails("LIMIT_EXCEEDED"));
  release(approved("cancelled")); await new Promise((r) => setImmediate(r));
  ledger.finishSession(ledger.beginSession("s", "turn", "after"), false);
});

test("crashed process releases concurrency but retains its unknown billing ceiling", (t) => {
  const { ledger, db } = fixture(t);
  const script = `import { UsageLedger } from './src/server/usage/ledger.ts'; const l=new UsageLedger(${JSON.stringify(db)},${JSON.stringify(policy())}); l.reserve(${JSON.stringify(call)});`;
  const child = spawnSync(process.execPath, ["--conditions=react-server", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const recovered = new UsageLedger(db, policy());
  assert.equal(recovered.snapshot().dailyCostMicros, 60); assert.equal(recovered.snapshot().calls[0].status, "failed");
  assert.throws(() => recovered.reserve(call), fails("LIMIT_EXCEEDED")); recovered.close();
  // Neither raw questions, audio nor authentication secrets belong in operational records.
  const bytes = readFileSync(db); assert.ok(!bytes.includes(Buffer.from("질문 원문"))); assert.equal(ledger.snapshot().calls.length, 1);
});

test("two independent processes competing for the final budget can admit only one call", async (t) => {
  const { db } = fixture(t);
  const script = `import { UsageLedger } from './src/server/usage/ledger.ts'; try { const l=new UsageLedger(${JSON.stringify(db)},${JSON.stringify(policy())}); l.reserve(${JSON.stringify(call)}); console.log('admitted'); l.close(); } catch(e) {console.log(e.code);}`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--conditions=react-server", "--input-type=module", "-e", script]); let output = "";
    child.stdout.on("data", (x) => output += x); child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(output.trim()) : reject(new Error(`exit ${code}`)));
  });
  assert.deepEqual((await Promise.all([run(), run()])).sort(), ["LIMIT_EXCEEDED", "admitted"]);
});

test("an existing server connection recovers another process's crashed call and session slots", (t) => {
  const settings = { plans: { "example:llm_generation": { mode: "free", maxCostMicros: 0 } }, maxConcurrent: 1 };
  const { ledger, db } = fixture(t, settings);
  const script = `import { UsageLedger } from './src/server/usage/ledger.ts'; const l=new UsageLedger(${JSON.stringify(db)},${JSON.stringify(policy(settings))}); l.reserve(${JSON.stringify(call)}); l.beginSession('s','turn','dead-request');`;
  const child = spawnSync(process.execPath, ["--conditions=react-server", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const current = ledger.reserve(call); ledger.finish(current, "completed");
  ledger.finishSession(ledger.beginSession("s", "turn", "new-request"), true);
  assert.equal(ledger.snapshot().calls[0].status, "failed");
});
