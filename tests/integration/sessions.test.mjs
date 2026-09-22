import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// Runs against an isolated production server. No external AI APIs or API keys.
test("production HTTP: cookie rotation, cross-route reset, capacity and restart", { timeout: 30_000 }, async t => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = "http://127.0.0.1:" + port;
  let child, log = "";
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const fallback = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await exited; } finally { clearTimeout(fallback); }
  }
  t.after(stop);
  async function start() {
    log = "";
    child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin, NEXT_TELEMETRY_DISABLED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", chunk => { log = (log + chunk).slice(-8000); });
    child.stderr.on("data", chunk => { log = (log + chunk).slice(-8000); });
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error("Server exited: " + log);
      try {
        const response = await fetch(origin, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch {}
      await delay(50);
    }
    throw new Error("Server did not start: " + log);
  }
  async function create(cookie, suppliedOrigin = origin) {
    const response = await fetch(origin + "/api/sessions", {
      method: "POST", headers: { origin: suppliedOrigin, "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ characterId: "sejong" }),
    });
    const setCookie = response.headers.get("set-cookie");
    return { response, body: await response.json(), cookie: setCookie?.split(";")[0] };
  }
  async function remove(cookie) {
    return fetch(origin + "/api/sessions/current", {
      method: "DELETE", headers: { origin, cookie },
    });
  }

  await start();
  assert.equal((await create(undefined, "https://foreign.example")).response.status, 403);
  const sessions = [];
  for (let i = 0; i < 5; i++) {
    const result = await create();
    assert.equal(result.response.status, 201, JSON.stringify(result.body));
    assert.equal(result.response.headers.get("cache-control"), "no-store");
    assert.match(result.cookie, /^sejong_session=[A-Za-z0-9_-]{43}$/);
    sessions.push(result);
  }
  assert.equal(new Set(sessions.map(item => item.body.sessionId)).size, 5);
  assert.equal((await create()).response.status, 503);

  const replacement = await create(sessions[0].cookie);
  assert.equal(replacement.response.status, 201);
  assert.notEqual(replacement.cookie, sessions[0].cookie);
  // At capacity, only an owner of a currently live session can replace a slot.
  assert.equal((await create(sessions[0].cookie)).response.status, 503);

  const deleted = await remove(sessions[1].cookie);
  assert.equal(deleted.status, 200);
  assert.deepEqual(await deleted.json(), { status: "deleted" });
  assert.match(deleted.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await create()).response.status, 201); // DELETE and POST share one store.
  assert.equal((await remove(sessions[1].cookie)).status, 200);
  assert.equal((await create()).response.status, 503); // Repeated delete freed no other user's slot.

  await stop();
  await start();
  for (let i = 0; i < 5; i++) assert.equal((await create()).response.status, 201);
  assert.equal((await create(replacement.cookie)).response.status, 503); // Pre-restart token is no longer an owner.
  t.diagnostic("Verified isolated production server twice; no paid API calls.");
});
