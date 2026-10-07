import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("production chat HTTP: real pipeline, sources, cancellation, reset and ownership", { timeout: 60000 }, async (t) => {
  const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const directory = await mkdtemp(join(tmpdir(), "sejong-chat-integration-"));
  const child = spawn(process.execPath, ["--import", new URL("../helpers/chat-gemini-fetch.mjs", import.meta.url).href,
    "node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, GEMINI_API_KEY: "synthetic-offline-key",
      USAGE_DB_PATH: join(directory, "ledger.sqlite"), USAGE_PROVIDER_PLANS: JSON.stringify({ "gemini:llm_generation": { mode: "free", maxCostMicros: 0 } }), NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "pipe",
  });
  let log = ""; child.stdout.on("data", chunk => { log += chunk; }); child.stderr.on("data", chunk => { log += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exited = once(child, "exit"); child.kill(); await exited; }
    await rm(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin)).ok) { ready = true; break; } } catch { /* Starting. */ }
    await delay(100);
  }
  assert.ok(ready, log);
  const create = async () => {
    const response = await fetch(`${origin}/api/sessions`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ characterId: "sejong" }) });
    assert.equal(response.status, 201);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const cookie = await create();
  const call = (path, method, body, owner = cookie) => fetch(`${origin}${path}`, { method, headers: { origin, cookie: owner, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const first = { requestId: "http-first", text: "훈민정음은 왜 만들었나요?" };
  const approved = await call("/api/turns", "POST", first);
  assert.equal(approved.status, 200);
  const answer = (await approved.json()).answer;
  assert.ok(answer.answerId); assert.ok(answer.sources.length > 0);
  assert.equal((await (await call("/api/turns", "POST", first)).json()).answer.answerId, answer.answerId);
  const other = await create();
  assert.equal((await call("/api/requests/http-first", "GET", undefined, other)).status, 404);
  const running = call("/api/turns", "POST", { requestId: "http-cancel", text: "훈민정음에 대해 알려주세요." });
  for (let i = 0; i < 20; i++) { const state = await call("/api/requests/http-cancel", "GET"); if (state.status === 200) break; await delay(10); }
  assert.equal((await (await call("/api/requests/http-cancel", "DELETE")).json()).status, "cancelled");
  assert.equal((await (await running).json()).status, "cancelled");
  await delay(300);
  assert.equal((await (await call("/api/requests/http-cancel", "GET")).json()).status, "cancelled");
  assert.equal((await call("/api/sessions/current", "DELETE")).status, 200);
  assert.equal((await call("/api/turns", "POST", { requestId: "old-session", text: "질문" })).status, 401);
  const fresh = await create();
  assert.equal((await call("/api/turns", "POST", { requestId: "fresh-session", text: "훈민정음은 왜 만들었나요?" }, fresh)).status, 200);
});
