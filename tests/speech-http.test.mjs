import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server.js";
import { loadTs } from "./helpers/load-ts.mjs";

const { SessionStore, IDLE_TIMEOUT_MS } = loadTs("src/server/sessions/store.ts");
const { ApprovedSpeechStore } = loadTs("src/server/tts/approved-speech.ts");
const { AzureSpeechError } = loadTs("src/server/tts/azure-request.ts");
const { SpeechHttp } = loadTs("src/server/tts/http.ts");
const origin = "https://sejong.example";
const bytes = Uint8Array.from([73, 68, 51, 1, 2, 3]);

function request(cookie, { method = "POST", body = JSON.stringify({ requestId: "speech_1", answerId: "answer_1" }), headers = {} } = {}) {
  return new NextRequest(origin + "/api/speech", {
    method,
    headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers },
    ...(method === "GET" ? {} : { body }),
  });
}

function approve(handle, answerId = "answer_1", text = "반갑구나.") {
  handle.appendApprovedTurn({ userText: "안녕하세요", answer: {
    answerId, text, kind: "conversation", factIds: [], sources: [],
    personaVersion: "test", contentVersion: "test",
  } });
}

function harness(t, synthesize = async (answer) => ({ answerId: answer.answerId, audio: bytes, mimeType: "audio/mpeg" })) {
  const savedOrigin = process.env.APP_ORIGIN;
  process.env.APP_ORIGIN = origin;
  let now = Date.now();
  const sessions = new SessionStore({ now: () => now });
  const tokens = [];
  t.after(() => {
    tokens.forEach((token) => sessions.revoke(token));
    if (savedOrigin === undefined) delete process.env.APP_ORIGIN;
    else process.env.APP_ORIGIN = savedOrigin;
  });
  return {
    sessions,
    http: new SpeechHttp(sessions, new ApprovedSpeechStore(synthesize)),
    create() {
      const { token } = sessions.create();
      tokens.push(token);
      return { token, cookie: `__Host-sejong_session=${token}`, handle: sessions.authenticate(token) };
    },
    advance(ms) { now += ms; },
  };
}

test("POST returns the speech contract and GET returns private MP3 bytes", async (t) => {
  const seen = [];
  const h = harness(t, async (answer) => {
    seen.push(answer.text);
    return { answerId: answer.answerId, audio: bytes, mimeType: "audio/mpeg" };
  });
  const owner = h.create();
  approve(owner.handle);
  const response = await h.http.post(request(owner.cookie));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = await response.json();
  assert.deepEqual(body, {
    requestId: "speech_1", operation: "speech", status: "completed", answerId: "answer_1",
    audio: { url: "/api/speech/audio/answer_1", mimeType: "audio/mpeg", expiresAt: new Date(owner.handle.assertActive().expiresAt).toISOString() },
  });
  assert.deepEqual(seen, ["반갑구나."]);
  assert.ok(!JSON.stringify(body).includes(owner.token));
  const audio = h.http.getAudio(request(owner.cookie, { method: "GET" }), "answer_1");
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get("content-type"), "audio/mpeg");
  assert.equal(audio.headers.get("cache-control"), "private, no-store");
  assert.equal(audio.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await audio.arrayBuffer()), bytes);
});

test("retransmissions and concurrent requests share one synthesis; changed input conflicts", async (t) => {
  let calls = 0;
  const h = harness(t, async (answer) => {
    calls += 1;
    return { answerId: answer.answerId, audio: bytes, mimeType: "audio/mpeg" };
  });
  const owner = h.create();
  approve(owner.handle);
  approve(owner.handle, "answer_2");
  const responses = await Promise.all([h.http.post(request(owner.cookie)), h.http.post(request(owner.cookie))]);
  assert.deepEqual(await responses[0].json(), await responses[1].json());
  assert.equal((await h.http.post(request(owner.cookie))).status, 200);
  const conflict = await h.http.post(request(owner.cookie, { body: JSON.stringify({ requestId: "speech_1", answerId: "answer_2" }) }));
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).code, "REQUEST_CONFLICT");
  const replay = await h.http.post(request(owner.cookie, { body: JSON.stringify({ requestId: "speech_2", answerId: "answer_1" }) }));
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).requestId, "speech_2");
  assert.equal(calls, 1);
});

test("another session cannot synthesize or read an owner's answer; reads never synthesize", async (t) => {
  let calls = 0;
  const h = harness(t, async (answer) => { calls += 1; return { answerId: answer.answerId, audio: bytes, mimeType: "audio/mpeg" }; });
  const owner = h.create(), other = h.create();
  approve(owner.handle);
  assert.equal(h.http.getAudio(request(owner.cookie, { method: "GET" }), "answer_1").status, 404);
  await h.http.post(request(owner.cookie));
  const denied = await h.http.post(request(other.cookie));
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).code, "REQUEST_NOT_FOUND");
  for (const id of ["answer_1", "unknown", "../answer_1"]) {
    const read = h.http.getAudio(request(other.cookie, { method: "GET" }), id);
    assert.equal(read.status, 404);
    assert.equal(read.headers.get("cache-control"), "private, no-store");
  }
  assert.equal(calls, 1);
});

test("identical request IDs in different sessions remain independent", async (t) => {
  const seen = [];
  const h = harness(t, async (answer) => { seen.push(answer.text); return { answerId: answer.answerId, audio: bytes, mimeType: "audio/mpeg" }; });
  const first = h.create(), second = h.create();
  approve(first.handle, "answer_1", "첫 대화.");
  approve(second.handle, "answer_1", "둘째 대화.");
  assert.equal((await h.http.post(request(first.cookie))).status, 200);
  assert.equal((await h.http.post(request(second.cookie))).status, 200);
  assert.deepEqual(seen, ["첫 대화.", "둘째 대화."]);
});

test("only the two ID fields are accepted; client text, credentials and malformed JSON are rejected", async (t) => {
  let calls = 0;
  const h = harness(t, async () => { calls += 1; throw new Error("must not synthesize"); });
  const owner = h.create();
  approve(owner.handle);
  const valid = { requestId: "speech_1", answerId: "answer_1" };
  const invalid = ["{", "null", "[]", "{}", " ".repeat(1025),
    ...["text", "sessionId", "token", "apiKey", "system", "history"].map((key) => JSON.stringify({ ...valid, [key]: "injected" })),
    ...["", "a".repeat(81), "../answer", "id with spaces", 12].flatMap((id) => [
      JSON.stringify({ ...valid, requestId: id }), JSON.stringify({ ...valid, answerId: id }),
    ]),
  ];
  for (const body of invalid) {
    const response = await h.http.post(request(owner.cookie, { body }));
    assert.equal(response.status, 400);
    const error = await response.json();
    assert.equal(error.code, "INVALID_INPUT");
    assert.equal(error.requestId, null);
  }
  assert.equal((await h.http.post(request(owner.cookie, { headers: { "content-type": "text/plain" } }))).status, 400);
  assert.equal(calls, 0);
});

test("streamed bodies are capped even without Content-Length", async (t) => {
  const h = harness(t), owner = h.create();
  let cancelled = false;
  const req = new NextRequest(origin + "/api/speech", {
    method: "POST", duplex: "half",
    headers: { origin, cookie: owner.cookie, "content-type": "application/json" },
    body: new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(600)); },
      cancel() { cancelled = true; },
    }),
  });
  assert.equal((await h.http.post(req)).status, 400);
  assert.equal(cancelled, true);
});

test("missing cookies and foreign origins cannot synthesize or read audio", async (t) => {
  let calls = 0;
  const h = harness(t, async () => { calls += 1; throw new Error("must not synthesize"); });
  const owner = h.create();
  approve(owner.handle);
  for (const [cookie, headers, status] of [
    [undefined, {}, 401], [owner.cookie, { origin: "https://foreign.example" }, 403],
    [owner.cookie, { "sec-fetch-site": "cross-site" }, 403], ["__Host-sejong_session=not-a-token", {}, 401],
  ]) {
    for (const response of [await h.http.post(request(cookie, { headers })), h.http.getAudio(request(cookie, { method: "GET", headers }), "answer_1")]) {
      assert.equal(response.status, status);
      assert.equal(response.headers.get("set-cookie"), null);
      assert.ok(response.headers.get("cache-control").includes("no-store"));
    }
  }
  assert.equal(calls, 0);
});

test("reset during body reading prevents synthesis", async (t) => {
  let calls = 0, controller;
  const h = harness(t, async () => { calls += 1; throw new Error("must not synthesize"); });
  const owner = h.create();
  approve(owner.handle);
  const req = new NextRequest(origin + "/api/speech", {
    method: "POST", duplex: "half", headers: { origin, cookie: owner.cookie, "content-type": "application/json" },
    body: new ReadableStream({ start(stream) { controller = stream; } }),
  });
  const pending = h.http.post(req);
  h.sessions.revoke(owner.token);
  controller.enqueue(new TextEncoder().encode('{"requestId":"speech_1","answerId":"answer_1"}'));
  controller.close();
  assert.equal((await pending).status, 401);
  assert.equal(calls, 0);
});

test("reset during synthesis blocks its late response and authenticated audio", async (t) => {
  let started, release;
  const ready = new Promise((resolve) => { started = resolve; });
  const h = harness(t, (answer) => {
    started();
    return new Promise((resolve) => { release = () => resolve({ answerId: answer.answerId, audio: bytes, mimeType: "audio/mpeg" }); });
  });
  const owner = h.create();
  approve(owner.handle);
  const pending = h.http.post(request(owner.cookie));
  await ready;
  h.sessions.revoke(owner.token);
  release();
  const response = await pending;
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "SESSION_EXPIRED");
  assert.equal(h.http.getAudio(request(owner.cookie, { method: "GET" }), "answer_1").status, 401);
});

test("audio GET without Origin works and never extends idle expiry", async (t) => {
  const h = harness(t), owner = h.create();
  approve(owner.handle);
  await h.http.post(request(owner.cookie));
  h.advance(IDLE_TIMEOUT_MS - 1);
  const req = new NextRequest(origin + "/api/speech/audio/answer_1", { headers: { cookie: owner.cookie, "sec-fetch-site": "same-origin" } });
  assert.equal(h.http.getAudio(req, "answer_1").status, 200);
  h.advance(1);
  assert.equal(h.http.getAudio(req, "answer_1").status, 401);
});

test("provider errors follow HTTP codes, hide details and retain failed request IDs", async (t) => {
  let calls = 0;
  const failures = [new AzureSpeechError("LIMIT_EXCEEDED", true), new AzureSpeechError("UPSTREAM_TIMEOUT", true), new Error("private API key and raw provider details")];
  const h = harness(t, async (answer) => {
    calls += 1;
    if (failures.length) throw failures.shift();
    return { answerId: answer.answerId, audio: bytes, mimeType: "audio/mpeg" };
  });
  const owner = h.create();
  approve(owner.handle);
  for (const [number, status, code] of [[1, 429, "LIMIT_EXCEEDED"], [2, 504, "UPSTREAM_TIMEOUT"], [3, 503, "UNAVAILABLE"]]) {
    const options = { body: JSON.stringify({ requestId: `speech_${number}`, answerId: "answer_1" }) };
    const response = await h.http.post(request(owner.cookie, options));
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.code, code);
    assert.equal(body.requestId, `speech_${number}`);
    assert.ok(!JSON.stringify(body).includes("private API key"));
    assert.equal((await h.http.post(request(owner.cookie, options))).status, status);
  }
  const retried = await h.http.post(request(owner.cookie, { body: '{"requestId":"speech_4","answerId":"answer_1"}' }));
  assert.equal(retried.status, 200);
  assert.equal(calls, 4);
});

test("session request records are bounded and existing requests still replay at capacity", async (t) => {
  const h = harness(t), owner = h.create();
  approve(owner.handle);
  for (let i = 0; i < 100; i++) {
    assert.equal((await h.http.post(request(owner.cookie, { body: JSON.stringify({ requestId: `speech_${i}`, answerId: "answer_1" }) }))).status, 200);
  }
  const limited = await h.http.post(request(owner.cookie, { body: '{"requestId":"speech_new","answerId":"answer_1"}' }));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).retryable, false);
  assert.equal((await h.http.post(request(owner.cookie))).status, 200);
});

test("the POST and dynamic GET route entry points share the runtime service", async (t) => {
  const h = harness(t), owner = h.create();
  approve(owner.handle);
  const saved = globalThis.sejongSpeechHttp;
  globalThis.sejongSpeechHttp = h.http;
  t.after(() => {
    if (saved === undefined) delete globalThis.sejongSpeechHttp;
    else globalThis.sejongSpeechHttp = saved;
  });
  const { POST } = loadTs("src/app/api/speech/route.ts");
  const { GET } = loadTs("src/app/api/speech/audio/[answerId]/route.ts");
  assert.equal((await POST(request(owner.cookie))).status, 200);
  const response = await GET(request(owner.cookie, { method: "GET" }), { params: Promise.resolve({ answerId: "answer_1" }) });
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
});
