import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.mjs";
const { encodePcmWav, inspectPcmWav } = loadTs("src/features/voice-input/pcm-wav.ts");
const { normalizeAudio } = loadTs("src/features/voice-input/normalize-audio.ts");
const signal = () => new AbortController().signal;
const input = new Blob(["compressed audio"], { type: "audio/webm" });
const decoded = (channels, sampleRate = 16000) => ({ sampleRate, length: channels[0].length, numberOfChannels: channels.length, getChannelData: (i) => channels[i] });

test("WAV encoder writes RIFF sizes, signed little-endian PCM16, mono and 16kHz", () => {
  const buffer = encodePcmWav(new Float32Array([-2, -1, -.5, 0, .5, 1, 2]));
  const bytes = Buffer.from(buffer);
  assert.equal(bytes.toString("ascii", 0, 4), "RIFF"); assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
  assert.equal(bytes.readUInt32LE(4), buffer.byteLength - 8); assert.equal(bytes.readUInt32LE(40), 14);
  assert.deepEqual(Array.from({ length: 7 }, (_, i) => bytes.readInt16LE(44 + i * 2)), [-32768, -32768, -16384, 0, 16384, 32767, 32767]);
  const meta = inspectPcmWav(buffer); assert.equal(meta.sampleRate, 16000); assert.equal(meta.channels, 1); assert.equal(meta.bitsPerSample, 16);
});
test("30-second normalized audio is 960044 bytes, within 5MB", async () => {
  const wav = await normalizeAudio(input, signal(), undefined, async () => decoded([new Float32Array(480000).fill(.1)]));
  assert.equal(wav.type, "audio/wav"); assert.equal(wav.size, 960044); assert.ok(wav.size <= 5_000_000);
  assert.equal(inspectPcmWav(await wav.arrayBuffer()).durationMs, 30000);
});
test("stereo channels are averaged into mono and recorder padding is clipped to 30s", async () => {
  const wav = await normalizeAudio(input, signal(), undefined, async () => decoded([new Float32Array([.2, .4]), new Float32Array([.4, .2])]));
  assert.ok(Math.abs(new DataView(await wav.arrayBuffer()).getInt16(44, true) - Math.round(.3 * 32767)) <= 1);
  const padded = async () => decoded([new Float32Array(481000).fill(.1)]);
  await assert.rejects(normalizeAudio(input, signal(), undefined, padded), { code: "AUDIO_TOO_LONG" });
  const limited = await normalizeAudio(input, signal(), 30010, padded);
  assert.equal(inspectPcmWav(await limited.arrayBuffer()).durationMs, 30000);
});
test("empty, silent, oversized and undecodable audio fail safely", async () => {
  await assert.rejects(normalizeAudio(new Blob([]), signal()), { code: "AUDIO_EMPTY" });
  await assert.rejects(normalizeAudio(new Blob([new Uint8Array(5_000_001)]), signal()), { code: "AUDIO_TOO_LARGE" });
  await assert.rejects(normalizeAudio(input, signal(), undefined, async () => decoded([new Float32Array(16000)])), { code: "AUDIO_SILENT" });
  await assert.rejects(normalizeAudio(input, signal(), undefined, async () => { throw new Error("private decoder diagnostics"); }), { code: "AUDIO_UNSUPPORTED", message: "파일이 손상되었거나 이 브라우저에서 읽을 수 없는 형식이에요." });
});
test("abort during decoding rejects and never turns a late result into an upload", async () => {
  const abort = new AbortController(); let started, finish;
  const ready = new Promise((resolve) => { started = resolve; });
  const pending = normalizeAudio(input, abort.signal, undefined, () => { started(); return new Promise((resolve) => { finish = resolve; }); });
  await ready; abort.abort(); await assert.rejects(pending, { name: "AbortError" });
  finish(decoded([new Float32Array(16000).fill(.1)]));
  await assert.rejects(normalizeAudio(input, abort.signal), { name: "AbortError" });
});
test("WAV validation rejects header spoofing, corrupt chunks, wrong rate and duration", () => {
  const wav = () => encodePcmWav(new Float32Array(100).fill(.1));
  for (const [offset, value] of [[24, 22050], [40, 90000], [4, 0], [28, 1]]) {
    const b = wav(); new DataView(b).setUint32(offset, value, true); assert.throws(() => inspectPcmWav(b));
  }
  assert.throws(() => encodePcmWav(new Float32Array(480001)));
  assert.throws(() => encodePcmWav(new Float32Array()));
});
