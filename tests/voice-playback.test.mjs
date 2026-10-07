import test from "node:test";
import assert from "node:assert/strict";
import { PlaybackController } from "../src/features/voice-output/playback-controller.ts";
import { createPlaybackFixture } from "./fixtures/contracts.ts";

function createHarness({ failFirstPlay = false } = {}) {
  const states = [];
  const audios = [];
  const revoked = [];
  let nextUrl = 1;

  const controller = new PlaybackController({
    createAudio(url) {
      const audio = {
        url,
        currentTime: 0,
        playbackRate: 1,
        onended: null,
        playCalls: 0,
        pauseCalls: 0,
        async play() {
          this.playCalls += 1;
          if (failFirstPlay) {
            failFirstPlay = false;
            throw new Error("Playback failed");
          }
        },
        pause() { this.pauseCalls += 1; },
      };
      audios.push(audio);
      return audio;
    },
    createObjectUrl() { return `blob:fixture-${nextUrl++}`; },
    revokeObjectUrl(url) { revoked.push(url); },
    onStateChange(state) { states.push({ ...state }); },
  });

  return { controller, states, audios, revoked };
}

test("plays a fixture and applies speed changes to the current audio", async () => {
  const harness = createHarness();

  harness.controller.setSpeed(1.2);
  await harness.controller.play(createPlaybackFixture());

  assert.equal(harness.audios[0].playCalls, 1);
  assert.equal(harness.audios[0].playbackRate, 1.2);
  assert.equal(harness.controller.getState().status, "playing");
  assert.deepEqual(
    harness.states.map((state) => state.status),
    ["idle", "loading", "playing"],
  );
});

test("stops at the beginning and can replay the same audio", async () => {
  const harness = createHarness();
  await harness.controller.play(createPlaybackFixture());
  harness.audios[0].currentTime = 3;

  harness.controller.stop();
  assert.equal(harness.audios[0].pauseCalls, 1);
  assert.equal(harness.audios[0].currentTime, 0);
  assert.equal(harness.controller.getState().status, "paused");

  await harness.controller.replay();
  assert.equal(harness.audios[0].playCalls, 2);
  assert.equal(harness.controller.getState().status, "playing");
});

test("releases object URLs when audio is replaced or reset", async () => {
  const harness = createHarness();
  await harness.controller.play(createPlaybackFixture());
  await harness.controller.play(createPlaybackFixture());

  assert.deepEqual(harness.revoked, ["blob:fixture-1"]);
  assert.equal(harness.audios[0].pauseCalls, 1);

  harness.controller.reset();
  assert.deepEqual(harness.revoked, ["blob:fixture-1", "blob:fixture-2"]);
  assert.equal(harness.controller.getState().status, "idle");
});

test("reports playback errors, releases the failed audio, and can retry", async () => {
  const harness = createHarness({ failFirstPlay: true });

  await harness.controller.play(createPlaybackFixture());
  assert.equal(harness.controller.getState().status, "error");
  assert.deepEqual(harness.revoked, ["blob:fixture-1"]);
  assert.equal(harness.audios[0].pauseCalls, 1);

  await harness.controller.play(createPlaybackFixture());
  assert.deepEqual(harness.revoked, ["blob:fixture-1"]);
  assert.equal(harness.controller.getState().status, "playing");
});

test("finishing playback permits replay of the retained audio", async () => {
  const harness = createHarness();
  await harness.controller.play(createPlaybackFixture());

  harness.audios[0].onended();
  assert.equal(harness.controller.getState().status, "paused");
  assert.deepEqual(harness.revoked, []);

  await harness.controller.replay();
  assert.equal(harness.audios[0].playCalls, 2);
  assert.equal(harness.controller.getState().status, "playing");
});
