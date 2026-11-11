// ElevenLabs Speech Engine 역할을 흉내 내 실제 WS 서버 스크립트를 띄워 본다.
// 실제 ElevenLabs·유료 호출은 없고, 가짜 키로 서명한 JWT를 사용한다.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import WebSocket from "ws";

const API_KEY = "sk_fake_for_tests_only";
const PORT = 31000 + Math.floor(Math.random() * 1000);

function jwt(apiKey, claims = {}) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: "HS256", typ: "JWT" });
  const body = b64({ iss: "https://api.elevenlabs.io/convai/speech-engine", sub: "convai_speech_engine_upstream", iat: now, exp: now + 60, ...claims });
  const secret = createHash("sha256").update(apiKey, "utf-8").digest();
  const sig = createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

async function startServer(t) {
  const child = spawn(process.execPath, ["scripts/realtime-poc/speech-engine-server.mjs"], {
    env: { ...process.env, ELEVENLABS_API_KEY: API_KEY, ELEVENLABS_SPEECH_ENGINE_ID: "seng_test", REALTIME_POC_WS_PORT: String(PORT), REALTIME_POC_ANSWER_MODULE: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.setEncoding("utf8").on("data", (d) => logs.push(...d.split("\n").filter(Boolean)));
  child.stderr.setEncoding("utf8").on("data", (d) => logs.push(d));
  t.after(() => child.kill());
  for (let i = 0; i < 400 && !logs.some((l) => l.includes("준비")); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.ok(logs.some((l) => l.includes("준비")), logs.join("\n"));
  return logs;
}

function connect(token) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: token ? { "X-Elevenlabs-Speech-Engine-Authorization": token } : {} });
  const messages = [];
  const errors = [];
  ws.on("error", (e) => errors.push(e));
  ws.on("message", (d) => messages.push(JSON.parse(d.toString())));
  return { ws, messages, errors };
}

const waitFor = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("timed out");
};

test("speech engine server: auth, streamed answer, barge-in cancels the old answer", async (t) => {
  const logs = await startServer(t);

  // 1) 서명 없는/틀린 접속은 거절
  for (const token of [null, jwt("other_key")]) {
    const { ws, messages } = connect(token);
    await new Promise((resolve) => ws.on("close", resolve)); // events.once는 error에서 reject하므로 직접 기다림
    assert.equal(messages.length, 0, "rejected before any message");
  }

  // 2) 정상 접속 → 첫 질문에 답변 조각이 흘러옴
  const { ws, messages } = connect(jwt(API_KEY));
  await once(ws, "open");
  ws.send(JSON.stringify({ type: "init", conversation_id: "conv_test" }));
  ws.send(JSON.stringify({ type: "ping" }));
  ws.send(JSON.stringify({ type: "user_transcript", event_id: 1, user_transcript: [{ role: "user", content: "비밀 첫 질문" }] }));
  await waitFor(() => messages.some((m) => m.type === "agent_response" && m.event_id === 1 && m.content));
  assert.ok(messages.some((m) => m.type === "pong"));

  // 3) 답변 도중 끼어들기 → 1번 답변은 더 오지 않고 2번 답변이 끝까지 옴
  ws.send(JSON.stringify({ type: "user_transcript", event_id: 2, user_transcript: [{ role: "user", content: "비밀 첫 질문" }, { role: "user", content: "잠깐만요" }] }));
  const cut = messages.length;
  await waitFor(() => messages.some((m) => m.event_id === 2 && m.is_final === true), 5000);
  const afterCut = messages.slice(cut).filter((m) => m.type === "agent_response");
  assert.ok(afterCut.every((m) => m.event_id === 2 || (m.content === "" && m.is_final)), JSON.stringify(afterCut));
  assert.equal(afterCut.filter((m) => m.event_id === 1 && m.content).length, 0, "no new speech for the interrupted turn");

  ws.send(JSON.stringify({ type: "close" }));
  ws.close();
  await waitFor(() => logs.some((l) => l.includes('"event":"interrupted"')));
  await waitFor(() => logs.some((l) => l.includes('"outcome":"completed"')));
  assert.ok(!logs.join("\n").includes("비밀"), "transcript text is not logged");
  assert.ok(!logs.join("\n").includes(API_KEY), "API key is not logged");
});
