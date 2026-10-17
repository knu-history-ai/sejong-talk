import test from "node:test";
import assert from "node:assert/strict";
import { createChatAudioHarness, deferred } from "./helpers/chat-audio-lifecycle.mjs";

function setup(t, options) {
  const harness = createChatAudioHarness(options);
  const player = harness.mountAnswer();
  t.after(() => player.dispose());
  return { ...harness, player };
}

test("the stop button cancels Audio.play startup and ignores its late completion", async (t) => {
  const playGate = deferred();
  const { player, audios } = setup(t, { playGate });
  player.click(); await player.settle();
  assert.match(player.text(), /음성 준비 중/);
  player.click();
  assert.equal(audios[0].pauseCalls, 1);
  playGate.resolve(); await player.settle();
  assert.equal(audios[0].playing, false);
  assert.match(player.text(), /다시 듣기/);
});

test("speed selected during speech download is the speed used for playback", async (t) => {
  const { player, api, audios } = setup(t);
  const download = api.defer("GET", "/api/speech/audio/answer-1");
  player.click(); await player.settle();
  player.update({ speed: 1.2 });
  download.resolve(new Response(new Blob(["audio"]), { headers: { "content-type": "audio/wav" } }));
  await player.settle();
  assert.equal(audios[0].playbackRate, 1.2);
});

test("autoplay rejection is visible and a manual retry recovers", async (t) => {
  const { player, audios, urls } = setup(t, { rejectPlay: true });
  player.update({ autoPlay: true }); await player.settle();
  assert.equal(player.alerts().length, 1);
  assert.match(player.text(), /음성을 재생하지 못했어요/);
  assert.equal(urls.size, 0);
  player.click(); await player.settle();
  assert.equal(player.alerts().length, 0);
  assert.equal(audios[1].playing, true);
});

test("StrictMode cancels the first autoplay attempt and the live effect plays once", async (t) => {
  // Mount with autoPlay enabled, then simulate the development cleanup/setup cycle.
  const live = createChatAudioHarness();
  const pending = live.api.defer("GET", "/api/speech/audio/answer-1", { ignoreAbort: true });
  const strictPlayer = live.mountAnswer({ autoPlay: true });
  t.after(() => strictPlayer.dispose());
  await strictPlayer.settle();
  const first = live.api.calls[0];
  strictPlayer.host.strictCycle();
  await strictPlayer.settle();
  assert.equal(first.signal.aborted, true);
  pending.resolve(new Response(new Blob(["stale"]), { headers: { "content-type": "audio/wav" } }));
  await strictPlayer.settle();
  assert.equal(live.audios.length, 1);
  assert.equal(live.audios[0].playing, true);
  assert.equal(live.urls.size, 1);
  // A rerender must not synthesize or play yet another copy.
  strictPlayer.update({ speed: 1.2 }); await strictPlayer.settle();
  assert.equal(live.api.count("/api/speech"), 2);
  assert.equal(live.audios[0].playCalls, 1);
});

test("cancelled download cannot play when an abort-ignoring response arrives", async (t) => {
  const { player, api, audios, urls } = setup(t);
  const download = api.defer("GET", "/api/speech/audio/answer-1", { ignoreAbort: true });
  player.click(); await player.settle();
  const signal = api.calls[0].signal;
  player.click();
  assert.equal(signal.aborted, true);
  download.resolve(new Response(new Blob(["late"]), { headers: { "content-type": "audio/wav" } }));
  await player.settle();
  assert.equal(audios.length, 0); assert.equal(urls.size, 0);
});

test("answer replacement releases old audio and drops old late downloads", async (t) => {
  const { player, api, mountAnswer, audios, urls } = setup(t);
  const download = api.defer("GET", "/api/speech/audio/answer-1", { ignoreAbort: true });
  player.click(); await player.settle();
  const oldSignal = api.calls[0].signal;
  player.dispose();
  const next = mountAnswer({ answerId: "answer-2", autoPlay: true });
  t.after(() => next.dispose()); await next.settle();
  download.resolve(new Response(new Blob(["old"]), { headers: { "content-type": "audio/wav" } }));
  await next.settle();
  assert.equal(oldSignal.aborted, true);
  assert.equal(audios.length, 1); assert.equal(urls.size, 1);
  next.dispose();
  assert.equal(audios[0].playing, false); assert.equal(urls.size, 0);
});

async function chatSetup(t) {
  const harness = createChatAudioHarness();
  const app = harness.mountChat(); t.after(() => app.dispose());
  await app.start(); await app.ask();
  return { ...harness, app };
}

for (const pendingAudio of [false, true]) {
  test(`new chat cancels ${pendingAudio ? "a pending download" : "playing audio"} before DELETE completes`, async (t) => {
    const { app, api, audios, urls } = await chatSetup(t);
    const download = pendingAudio ? api.defer("GET", "/api/speech/audio/answer-1", { ignoreAbort: true }) : null;
    app.listen(); await app.settle();
    assert.equal(audios.some((audio) => audio.playing), !pendingAudio);
    const speech = api.calls.find((call) => call.url === "/api/speech");
    const deletion = api.defer("DELETE", "/api/sessions/current");
    app.click("새 대화");
    const resetting = app.button("새로 시작하기").props.onClick();
    // Cancellation must happen before React commits the disabled button.
    if (pendingAudio) assert.equal(speech.signal.aborted, true);
    assert.equal(urls.size, 0);
    assert.equal(audios.some((audio) => audio.playing), false);
    app.flush();
    assert.equal(app.playerButton().props.disabled, true);
    if (download) download.resolve(new Response(new Blob(["late"]), { headers: { "content-type": "audio/wav" } }));
    await app.settle();
    assert.equal(audios.some((audio) => audio.playing), false);
    deletion.resolve({ status: "deleted" }); await resetting; await app.settle();
    assert.equal(app.playerButton(), undefined); assert.equal(urls.size, 0);
  });
}

for (const pendingAudio of [false, true]) {
  test(`session replacement stops ${pendingAudio ? "a pending download" : "playing audio"}`, async (t) => {
    const { app, api, audios, urls } = await chatSetup(t);
    const download = pendingAudio ? api.defer("GET", "/api/speech/audio/answer-1", { ignoreAbort: true }) : null;
    app.listen(); await app.settle();
    assert.equal(audios.some((audio) => audio.playing), !pendingAudio);
    const speech = api.calls.find((call) => call.url === "/api/speech");
    app.storageEvent("sejong-session-change");
    if (pendingAudio) assert.equal(speech.signal.aborted, true);
    assert.equal(urls.size, 0); assert.equal(audios.some((audio) => audio.playing), false);
    if (download) download.resolve(new Response(new Blob(["late"]), { headers: { "content-type": "audio/wav" } }));
    await app.settle();
    assert.equal(app.playerButton(), undefined); assert.equal(urls.size, 0);
  });
}

test("speech SESSION_EXPIRED opens recovery and prevents another playback", async (t) => {
  const { app, api, audios } = await chatSetup(t);
  api.enqueue("POST", "/api/speech", new Response(JSON.stringify({ status: "failed", code: "SESSION_EXPIRED", message: "만료", requestId: null }), { status: 401 }));
  app.listen(); await app.settle();
  assert.match(app.text(), /대화 시간이 만료되었어요/);
  assert.equal(app.playerButton(), undefined); assert.equal(audios.length, 0);
});

for (const pendingAudio of [false, true]) {
  test(`a session-expired callback releases ${pendingAudio ? "pending TTS" : "playing audio"}`, async (t) => {
    const { app, api, audios, urls, recorders } = await chatSetup(t);
    const download = pendingAudio ? api.defer("GET", "/api/speech/audio/answer-1", { ignoreAbort: true }) : null;
    app.listen(); await app.settle();
    assert.equal(audios.some((audio) => audio.playing), !pendingAudio);
    const speech = api.calls.find((call) => call.url === "/api/speech");
    recorders[0].expire();
    if (pendingAudio) assert.equal(speech.signal.aborted, true);
    assert.equal(urls.size, 0); assert.equal(audios.some((audio) => audio.playing), false);
    app.flush();
    if (download) download.resolve(new Response(new Blob(["late"]), { headers: { "content-type": "audio/wav" } }));
    await app.settle();
    assert.match(app.text(), /대화 시간이 만료되었어요/);
    assert.equal(app.playerButton(), undefined); assert.equal(urls.size, 0);
  });
}

test("request transition cancels a pending old speech response even if the turn is then cancelled", async (t) => {
  const { app, api, audios, urls } = await chatSetup(t);
  const download = api.defer("GET", "/api/speech/audio/answer-1", { ignoreAbort: true });
  app.listen(); await app.settle();
  const speech = api.calls.find((call) => call.url === "/api/speech");
  const turn = api.defer("POST", "/api/turns");
  app.type("다음 질문"); app.submit();
  assert.equal(speech.signal.aborted, true);
  app.click("답변 취소");
  download.resolve(new Response(new Blob(["old"]), { headers: { "content-type": "audio/wav" } }));
  turn.resolve({ status: "cancelled" }); await app.settle();
  assert.equal(audios.length, 0); assert.equal(urls.size, 0);
  assert.match(app.text(), /답변 준비를 멈췄어요/);
});

for (const pendingAudio of [false, true]) {
  test(`microphone opens after ${pendingAudio ? "pending TTS cancellation" : "audio release"} and blocks playback through transcription`, async (t) => {
    const { app, api, audios, urls, recorders } = await chatSetup(t);
    const download = pendingAudio ? api.defer("GET", "/api/speech/audio/answer-1", { ignoreAbort: true }) : null;
    app.autoListen(true); await app.settle();
    app.record();
    const recorder = recorders[0];
    assert.equal(recorder.audioAtOpen, false); assert.equal(recorder.urlsAtOpen, 0);
    const requests = api.count("/api/speech");
    for (const phase of ["permission", "recording", "stopping", "transcribing"]) {
      recorder.phase(phase); app.flush();
      assert.equal(app.playerButton().props.disabled, true);
      app.listen(); await app.settle();
      assert.equal(api.count("/api/speech"), requests);
    }
    if (download) download.resolve(new Response(new Blob(["late"]), { headers: { "content-type": "audio/wav" } }));
    recorder.finish("인식한 질문"); app.flush(); await app.settle();
    assert.equal(app.playerButton().props.disabled, false);
    assert.equal(api.count("/api/speech"), requests, "ending recording must not autoplay the old answer again");
    assert.equal(audios.some((audio) => audio.playing), false); assert.equal(urls.size, 0);
  });
}

test("an approved answer with automatic listening uses the player without the obsolete preparation notice", async (t) => {
  const { app, api, audios } = await chatSetup(t);
  app.autoListen(true); await app.settle();
  await app.ask("다음 답변");
  assert.equal(api.count("/api/speech"), 2);
  assert.equal(audios[0].playing, false); assert.equal(audios[1].playing, true);
  assert.doesNotMatch(app.text(), /답변 듣기는 준비 중/);
});
