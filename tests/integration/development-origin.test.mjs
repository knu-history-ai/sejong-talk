import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

test("real Next development server accepts both loopback hosts without APP_ORIGIN", { timeout: 60_000 }, async t => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const env = { ...process.env, NODE_ENV: "development", NEXT_TELEMETRY_DISABLED: "1" };
  delete env.APP_ORIGIN;
  let log = "";
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "dev", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)), env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", chunk => { log = (log + chunk).slice(-8000); });
  child.stderr.on("data", chunk => { log = (log + chunk).slice(-8000); });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    const fallback = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await exited; } finally { clearTimeout(fallback); }
  });
  const ipOrigin = "http://127.0.0.1:" + port;
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error("Server exited: " + log);
    try {
      const response = await fetch(ipOrigin + "/api/sessions", { signal: AbortSignal.timeout(500) });
      if (response.status === 405) { ready = true; break; }
    } catch {}
    await delay(100);
  }
  assert.ok(ready, "Server did not start: " + log);
  for (const host of ["localhost", "127.0.0.1"]) {
    const origin = `http://${host}:${port}`;
    const response = await fetch(origin + "/api/sessions", {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: '{"characterId":"sejong"}',
    });
    assert.equal(response.status, 201, host + ": " + await response.text());
    const cookie = response.headers.get("set-cookie").split(";")[0];
    const reset = await fetch(origin + "/api/sessions/current", { method: "DELETE", headers: { origin, cookie } });
    assert.equal(reset.status, 200);
  }
  for (const origin of ["https://foreign.example", "http://localhost:" + port, "http://127.0.0.1:" + (port + 1)]) {
    const response = await fetch(ipOrigin + "/api/sessions", {
      method: "POST", headers: { origin, "content-type": "application/json" },
      body: '{"characterId":"sejong"}',
    });
    assert.equal(response.status, 403, origin);
    assert.equal(response.headers.get("set-cookie"), null);
  }
});
