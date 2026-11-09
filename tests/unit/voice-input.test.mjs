import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Use the repository's TypeScript compiler; no new runner/dependency is required.
const source = await readFile(new URL("../../src/features/voice-input/recorder.ts", import.meta.url), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { VoiceRecorder, MAX_AUDIO_BYTES, chooseMimeType, rms } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

function harness(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let now = 0;
  let stopped = 0;
  let requested = 0;
  let calls = 0;
  let state;
  let transcript;
  let received;
  const track = { readyState: "live", enabled: true, muted: false, stop() { stopped++; track.readyState = "ended"; }, onended: null };
  const stream = { getTracks: () => [track] };
  const context = {
    state: "running", resume: async () => {},
    close: async () => { context.state = "closed"; },
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createAnalyser: () => ({ fftSize: 2048, disconnect() {}, getFloatTimeDomainData: (samples) => samples.fill(options.silent ? 0 : 0.03) }),
  };
  const recorder = {
    state: "inactive", mimeType: options.mime || "audio/webm;codecs=opus",
    start() { if (options.startError) throw options.startError; recorder.state = "recording"; },
    stop() { recorder.state = "inactive"; },
    data(size = 400) { recorder.ondataavailable?.({ data: new Blob([new Uint8Array(size)]) }); },
    finish() { recorder.onstop?.(); },
  };
  const env = {
    supported: () => options.supported !== false,
    supportsMime: (mime) => options.noMime ? false : mime === recorder.mimeType,
    getStream: () => { requested++; return options.getStream ? options.getStream(stream) : Promise.resolve(stream); },
    createRecorder: () => { if (options.constructorError) throw options.constructorError; return recorder; },
    createContext: () => context,
    now: () => now,
  };
  const controller = new VoiceRecorder((value) => { state = value; }, (value) => { transcript = value; }, (recording, signal) => {
    calls++;
    received = { size: recording.blob.size, mime: recording.mimeType, signal };
    return options.transcribe ? options.transcribe(recording, signal) : Promise.resolve("훈민정음은 몇 글자였어요?");
  }, env);
  t.after(() => controller.dispose());
  return { controller, recorder, stream, track, context,
    tick(ms) { now += ms; t.mock.timers.tick(ms); },
    get state() { return state; }, get stopped() { return stopped; }, get requested() { return requested; },
    get transcript() { return transcript; }, get calls() { return calls; }, get received() { return received; },
  };
}

test("MIME negotiation handles Safari MP4, unsupported types and silence energy", () => {
  assert.equal(chooseMimeType((mime) => mime === "audio/mp4"), "audio/mp4");
  assert.equal(chooseMimeType(() => false), undefined);
  assert.equal(rms(new Float32Array(100)), 0);
  assert.ok(rms(new Float32Array([0.1, -0.1])) > 0.09);
});

test("normal stop releases microphone immediately; final chunk included exactly once", async (t) => {
  const h = harness(t);
  await h.controller.start(); h.tick(500);
  h.recorder.data(100); h.controller.stop(); h.controller.stop();
  assert.equal(h.stopped, 1); assert.equal(h.context.state, "closed");
  h.recorder.data(50); h.recorder.finish(); await flush();
  assert.equal(h.state.phase, "review"); assert.equal(h.received.size, 150);
  assert.equal(h.calls, 1); assert.match(h.transcript, /훈민정음/);
});

test("rapid start clicks request the microphone only once", async (t) => {
  const h = harness(t);
  await Promise.all([h.controller.start(), h.controller.start()]);
  assert.equal(h.requested, 1);
});

test("permission denial leaves a recoverable error and releases audio context", async (t) => {
  const h = harness(t, { getStream: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) });
  await h.controller.start();
  assert.equal(h.state.code, "PERMISSION_DENIED"); assert.equal(h.context.state, "closed");
});

test("cancel during permission request stops the late stream without recording", async (t) => {
  let grant;
  const h = harness(t, { getStream: (stream) => new Promise((resolve) => { grant = () => resolve(stream); }) });
  const pending = h.controller.start();
  h.controller.cancel(); grant(); await pending;
  assert.equal(h.stopped, 1); assert.equal(h.state.phase, "idle"); assert.equal(h.calls, 0);
});

test("cancel discards chunks and ignores queued data/stop callbacks", async (t) => {
  const h = harness(t); await h.controller.start(); h.tick(300);
  const lateData = h.recorder.ondataavailable;
  const lateStop = h.recorder.onstop;
  h.recorder.data(); h.controller.cancel();
  lateData({ data: new Blob(["late"]) }); lateStop(); await flush();
  assert.equal(h.stopped, 1); assert.equal(h.calls, 0); assert.equal(h.state.phase, "idle");
});

test("30 seconds automatically stops and frees microphone", async (t) => {
  const h = harness(t); await h.controller.start(); h.tick(30_000);
  assert.equal(h.state.phase, "stopping"); assert.equal(h.stopped, 1);
});

test("suspended timer cannot pass a recording longer than the time limit", async (t) => {
  const h = harness(t); await h.controller.start(); h.tick(31_000);
  assert.equal(h.state.code, "AUDIO_TOO_LONG"); assert.equal(h.calls, 0); assert.equal(h.stopped, 1);
});

test("5 MB boundary is accepted and excess final chunk is rejected", async (t) => {
  const h = harness(t); await h.controller.start(); h.tick(300);
  h.recorder.data(MAX_AUDIO_BYTES); h.controller.stop();
  h.recorder.data(1); h.recorder.finish(); await flush();
  assert.equal(h.state.code, "AUDIO_TOO_LARGE"); assert.equal(h.calls, 0);
});

test("exactly 5 MB remains valid", async (t) => {
  const h = harness(t); await h.controller.start(); h.tick(300);
  h.controller.stop(); h.recorder.data(MAX_AUDIO_BYTES); h.recorder.finish(); await flush();
  assert.equal(h.state.phase, "review"); assert.equal(h.received.size, MAX_AUDIO_BYTES);
});

test("silent and empty recordings never reach transcription", async (t) => {
  const h = harness(t, { silent: true }); await h.controller.start(); h.tick(300);
  h.controller.stop(); h.recorder.data(); h.recorder.finish(); await flush();
  assert.equal(h.state.code, "AUDIO_SILENT"); assert.equal(h.calls, 0);
});

test("empty blob is distinguished from silence", async (t) => {
  const h = harness(t); await h.controller.start(); h.tick(300);
  h.controller.stop(); h.recorder.finish(); await flush();
  assert.equal(h.state.code, "AUDIO_EMPTY"); assert.equal(h.calls, 0);
});

test("cancellation aborts transcription and ignores even an uncooperative late result", async (t) => {
  let resolve;
  const h = harness(t, { transcribe: () => new Promise((done) => { resolve = done; }) });
  await h.controller.start(); h.tick(300); h.controller.stop(); h.recorder.data(); h.recorder.finish();
  h.controller.cancel();
  assert.equal(h.received.signal.aborted, true);
  resolve("취소한 결과"); await flush();
  assert.equal(h.transcript, undefined); assert.equal(h.state.phase, "idle");
});

test("transcription timeout releases state and ignores subsequent completion", async (t) => {
  let resolve;
  const h = harness(t, { transcribe: () => new Promise((done) => { resolve = done; }) });
  await h.controller.start(); h.tick(300); h.controller.stop(); h.recorder.data(); h.recorder.finish();
  h.tick(20_000);
  assert.equal(h.state.code, "TRANSCRIPTION_TIMEOUT"); assert.equal(h.received.signal.aborted, true);
  resolve("늦은 결과"); await flush(); assert.equal(h.transcript, undefined);
});

test("missing final stop event does not leave UI stuck", async (t) => {
  const h = harness(t); await h.controller.start(); h.tick(300); h.controller.stop(); h.tick(3000);
  assert.equal(h.state.code, "RECORDING_FAILED"); assert.equal(h.stopped, 1);
});

test("unsupported browser and MIME do not ask for microphone access", async (t) => {
  const h = harness(t, { supported: false }); await h.controller.start();
  assert.equal(h.state.code, "UNSUPPORTED_BROWSER"); assert.equal(h.requested, 0);
});

test("no supported MIME is a distinct error", async (t) => {
  const h = harness(t, { noMime: true }); await h.controller.start();
  assert.equal(h.state.code, "AUDIO_UNSUPPORTED"); assert.equal(h.requested, 0);
});

test("MP4 recording uses the recorder's MIME in the output", async (t) => {
  const h = harness(t, { mime: "audio/mp4" }); await h.controller.start(); h.tick(300);
  h.controller.stop(); h.recorder.data(); h.recorder.finish(); await flush();
  assert.equal(h.received.mime, "audio/mp4");
});

test("unmount disposes recording and prevents future start", async (t) => {
  const h = harness(t); await h.controller.start(); h.controller.dispose(); await h.controller.start();
  assert.equal(h.stopped, 1); assert.equal(h.requested, 1); assert.equal(h.calls, 0);
});

test("device disconnection releases resources without transcription", async (t) => {
  const h = harness(t); await h.controller.start(); h.track.onended();
  assert.equal(h.state.code, "MICROPHONE_DISCONNECTED"); assert.equal(h.stopped, 1); assert.equal(h.calls, 0);
});

test("empty STT response returns a recoverable error", async (t) => {
  const h = harness(t, { transcribe: async () => " " });
  await h.controller.start(); h.tick(300); h.controller.stop(); h.recorder.data(); h.recorder.finish(); await flush();
  assert.equal(h.state.code, "TRANSCRIPT_EMPTY"); assert.equal(h.transcript, undefined);
});

test("STT failure is recoverable and start is blocked while transcription is pending", async (t) => {
  let reject;
  const h = harness(t, { transcribe: () => new Promise((_, fail) => { reject = fail; }) });
  await h.controller.start(); h.tick(300); h.controller.stop(); h.recorder.data(); h.recorder.finish();
  await h.controller.start(); assert.equal(h.requested, 1);
  reject(new Error("공급자 요청 실패")); await flush();
  assert.equal(h.state.code, "TRANSCRIPTION_FAILED"); assert.equal(h.transcript, undefined);
});

function development(t) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  t.after(() => { if (previous === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous; });
}

test("development diagnostics trace MP4 start; microphone request is synchronous before yielding", async (t) => {
  development(t);
  const h = harness(t, { mime: "audio/mp4" });
  const pending = h.controller.start();
  assert.equal(h.requested, 1);
  assert.equal(h.state.debug.getUserMediaRequested, true);
  await pending;
  assert.equal(h.state.debug.selectedMime, "audio/mp4");
  assert.equal(h.state.debug.actualMime, "audio/mp4");
  for (const key of ["getUserMediaSucceeded", "mediaRecorderCreated", "mediaRecorderStarted"]) assert.equal(h.state.debug[key], true);
});

for (const [name, code] of [["NotAllowedError", "PERMISSION_DENIED"], ["NotFoundError", "NO_MICROPHONE"], ["NotReadableError", "MICROPHONE_BUSY"]]) {
  test(`development identifies ${name} and releases busy state`, async (t) => {
    development(t);
    const h = harness(t, { getStream: () => Promise.reject(new DOMException("device failure", name)) });
    await h.controller.start();
    assert.equal(h.state.code, code);
    assert.equal(h.controller.isBusy(), false);
    assert.equal(h.state.debug["error.name"], name);
    assert.equal(h.state.debug["error.message"], "device failure");
    assert.equal(h.state.debug.errorStage, "getUserMedia");
    assert.equal(h.state.debug.getUserMediaSucceeded, false);
  });
}

for (const [name, code] of [["AbortError", "MICROPHONE_ABORTED"], ["InvalidStateError", "RECORDER_INVALID_STATE"], ["SecurityError", "MICROPHONE_BLOCKED"], ["TypeError", "RECORDING_UNAVAILABLE"]]) {
  test(`${name} from getUserMedia has its own recoverable code`, async (t) => {
    development(t);
    const error = name === "TypeError" ? new TypeError("not available") : new DOMException("not available", name);
    const h = harness(t, { getStream: () => Promise.reject(error) });
    await h.controller.start();
    assert.equal(h.state.phase, "error"); assert.equal(h.state.code, code);
    assert.equal(h.controller.isBusy(), false);
    assert.equal(h.state.debug["error.name"], name);
    assert.equal(h.state.debug.errorStage, "getUserMedia");
  });
}

test("development diagnostics report track state, release and blob without audio content", async (t) => {
  development(t);
  const h = harness(t);
  await h.controller.start();
  assert.equal(h.state.debug.streamTrackCount, "1");
  assert.equal(h.state.debug["streamTrack.readyState"], "live");
  assert.equal(h.state.debug["streamTrack.enabled"], "true");
  assert.equal(h.state.debug["streamTrack.muted"], "false");
  h.tick(500); h.recorder.data(100); h.controller.stop();
  assert.equal(h.state.debug["streamTrack.readyState"], "ended");
  assert.equal(h.state.debug.microphoneReleased, true);
  h.recorder.finish(); await flush();
  assert.equal(h.state.debug["blob.type"], "audio/webm;codecs=opus");
  assert.equal(h.state.debug["blob.size"], "100");
  assert.equal(h.state.debug.durationMs, "500");
  assert.match(h.state.debug.dataavailableCount, /^1 \(100 bytes\)$/);
});

for (const [option, stage, created] of [["constructorError", "MediaRecorder constructor", false], ["startError", "recorder.start()", true]]) {
  test(`development distinguishes ${stage} failure`, async (t) => {
    development(t);
    const h = harness(t, { [option]: new DOMException("unsupported", "NotSupportedError") });
    await h.controller.start();
    assert.equal(h.state.debug.errorStage, stage);
    assert.equal(h.state.debug.mediaRecorderCreated, created);
    assert.equal(h.state.debug.mediaRecorderStarted, false);
    assert.equal(h.stopped, 1);
  });
}

test("resume rejection remains visible and sensitive exception fields are redacted", async (t) => {
  development(t);
  const h = harness(t);
  h.context.resume = async () => { throw new Error("token=private-value Bearer secret-value https://private.example/key"); };
  await h.controller.start();
  assert.equal(h.state.code, "AUDIO_ANALYSIS_FAILED");
  assert.equal(h.state.debug.errorStage, "AudioContext.resume()");
  assert.doesNotMatch(h.state.debug["error.message"], /private-value|secret-value|private.example/);
});

test("production does not collect recording diagnostics", async (t) => {
  development(t);
  process.env.NODE_ENV = "production";
  const h = harness(t);
  await h.controller.start();
  assert.equal(h.state.debug, undefined);
});
