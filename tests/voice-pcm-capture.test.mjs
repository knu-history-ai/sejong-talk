import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.mjs";

const { capturedPcmToWav } = loadTs("src/features/voice-input/transcription.ts");
const { inspectPcmWav } = loadTs("src/features/voice-input/pcm-wav.ts");

const tone = (seconds, rate) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.2 * Math.sin(2 * Math.PI * 440 * i / rate));

test("live-captured 48kHz PCM becomes 16kHz mono PCM16 WAV without decoding the compressed recording", async () => {
  const wav = capturedPcmToWav({ samples: tone(2, 48_000), sampleRate: 48_000 });
  assert.equal(wav.type, "audio/wav");
  const info = inspectPcmWav(await wav.arrayBuffer());
  assert.equal(info.sampleRate, 16_000); assert.equal(info.channels, 1); assert.equal(info.bitsPerSample, 16);
  assert.equal(info.dataBytes, 2 * 32_000);
});

test("44.1kHz is resampled; output is capped at 30 seconds", async () => {
  const info = inspectPcmWav(await capturedPcmToWav({ samples: tone(31, 44_100), sampleRate: 44_100 }).arrayBuffer());
  assert.equal(info.dataBytes, 2 * 16_000 * 30);
});

test("missing, too short or silent capture falls back to decoding the recording", () => {
  assert.equal(capturedPcmToWav(undefined), undefined);
  assert.equal(capturedPcmToWav({ samples: tone(0.1, 48_000), sampleRate: 48_000 }), undefined);
  assert.equal(capturedPcmToWav({ samples: new Float32Array(48_000), sampleRate: 48_000 }), undefined);
  assert.equal(capturedPcmToWav({ samples: tone(1, 8_000), sampleRate: 8_000 }), undefined);
});
