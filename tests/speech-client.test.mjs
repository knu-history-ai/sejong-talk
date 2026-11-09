import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.mjs";

const { fetchApprovedSpeech } = loadTs("src/features/voice-output/speech-client.ts");
const input = { requestId: "speech_1", answerId: "answer_1" };
const completed = {
  ...input, operation: "speech", status: "completed",
  audio: { url: "/api/speech/audio/answer_1", mimeType: "audio/mpeg", expiresAt: "2026-10-07T00:30:00Z" },
};
const audio = () => new Response(Uint8Array.from([73, 68, 51]), { headers: { "Content-Type": "audio/mpeg" } });

test("requests only the approved IDs, uses same-origin credentials and downloads a Blob", async () => {
  const signal = new AbortController().signal;
  const calls = [];
  const blob = await fetchApprovedSpeech(input, signal, async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? Response.json(completed) : audio();
  });
  assert.equal(blob.type, "audio/mpeg");
  assert.equal(blob.size, 3);
  assert.deepEqual(JSON.parse(calls[0].init.body), input);
  assert.deepEqual(calls.map(({ url }) => url), ["/api/speech", "/api/speech/audio/answer_1"]);
  for (const { init } of calls) {
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal(init.signal, signal);
  }
});

test("mismatched IDs, operations and external audio URLs never cause an audio request", async () => {
  for (const response of [
    { ...completed, requestId: "old_request" }, { ...completed, answerId: "another_answer" },
    { ...completed, operation: "transcription" }, { ...completed, status: "processing" },
    { ...completed, audio: { ...completed.audio, url: "https://provider.example/audio" } },
    { ...completed, audio: { ...completed.audio, url: "/api/speech/audio/another_answer" } },
    { ...completed, audio: { ...completed.audio, mimeType: "text/html" } }, null,
  ]) {
    let calls = 0;
    await assert.rejects(fetchApprovedSpeech(input, new AbortController().signal, async () => {
      calls += 1;
      return Response.json(response);
    }), /현재 답변/);
    assert.equal(calls, 1);
  }
});

test("failed API messages preserve session expiry and do not download audio", async () => {
  let calls = 0;
  await assert.rejects(fetchApprovedSpeech(input, new AbortController().signal, async () => {
    calls += 1;
    return Response.json({ status: "failed", requestId: input.requestId, code: "SESSION_EXPIRED",
      message: "대화가 만료되었습니다.", retryable: false }, { status: 401 });
  }), { message: "대화가 만료되었습니다.", code: "SESSION_EXPIRED" });
  assert.equal(calls, 1);
});

test("expiry between synthesis and audio download is reported to the player", async () => {
  let calls = 0;
  await assert.rejects(fetchApprovedSpeech(input, new AbortController().signal, async () => {
    if (++calls === 1) return Response.json(completed);
    return Response.json({ status: "failed", code: "SESSION_EXPIRED", message: "새 대화를 시작해 주세요.", retryable: false, requestId: null }, { status: 401 });
  }), { code: "SESSION_EXPIRED" });
  assert.equal(calls, 2);
});

test("wrong MIME, empty audio and malformed responses cannot become playable Blobs", async () => {
  for (const badAudio of [new Response("html", { headers: { "Content-Type": "text/html" } }), new Response(null, { headers: { "Content-Type": "audio/mpeg" } })]) {
    let calls = 0;
    await assert.rejects(fetchApprovedSpeech(input, new AbortController().signal, async () => ++calls === 1 ? Response.json(completed) : badAudio));
  }
  await assert.rejects(fetchApprovedSpeech(input, new AbortController().signal, async () => new Response("not JSON")), /음성 응답/);
});

test("abort before a request or after a late synthesis response prevents audio download", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(fetchApprovedSpeech(input, controller.signal, async () => { calls += 1; return audio(); }), { name: "AbortError" });
  assert.equal(calls, 0);
  const active = new AbortController();
  await assert.rejects(fetchApprovedSpeech(input, active.signal, async () => {
    calls += 1;
    active.abort();
    return Response.json(completed); // Deliberately return a late response despite abort.
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("an audio response arriving after abort is never returned for playback", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(fetchApprovedSpeech(input, controller.signal, async () => {
    if (++calls === 1) return Response.json(completed);
    controller.abort();
    return audio();
  }), { name: "AbortError" });
});
