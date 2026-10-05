// Optional browser check: install Playwright separately or set PLAYWRIGHT_MODULE
// to its absolute index.mjs. Runs Chrome headless with a synthetic microphone.
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { mkdtemp, writeFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTs } from "../helpers/load-ts.mjs";
const { inspectPcmWav } = loadTs("src/features/voice-input/pcm-wav.ts");
const { handleStt } = loadTs("src/server/stt/http.ts");
process.env.NODE_ENV = "development";
process.env.STT_PROVIDER = "azure";
process.env.AZURE_SPEECH_KEY = "browser-boundary-test-key";
process.env.AZURE_SPEECH_REGION = "koreacentral";
let adapterCalls = 0;
const nativeFetch = globalThis.fetch;
// Only the external Azure network boundary is mocked. WAV validation, the
// HTTP handler and Azure adapter below are real production implementations.
globalThis.fetch = async (url, init) => {
  assert.equal(url, "https://koreacentral.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=ko-KR&format=detailed");
  const metadata = inspectPcmWav(init.body);
  assert.equal(metadata.sampleRate, 16000); assert.equal(metadata.channels, 1); assert.equal(metadata.bitsPerSample, 16);
  adapterCalls++;
  await new Promise((resolve) => setTimeout(resolve, 700));
  return Response.json({ RecognitionStatus: "Success", NBest: [{ Display: "세종대왕은 왜 훈민정음을 만들었어요?" }] });
};
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const temporary = await mkdtemp(join(tmpdir(), "sejong-voice-test-"));
const audioPath = join(temporary, "synthetic.wav");
// A continuous synthetic tone avoids the fake device's intermittent beep/silence.
const samples = 16000 * 5;
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF"); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(8000 * Math.sin(2 * Math.PI * 440 * i / 16000)), 44 + 2 * i);
await writeFile(audioPath, wav);
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${audioPath}`] });
const page = await browser.newPage({ viewport: { width: 360, height: 800 } });
const errors = [];
const apiCalls = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => { if (new URL(request.url()).pathname.startsWith("/api/")) apiCalls.push(request.url()); });
await page.addInitScript(() => {
  window.__tracks = [];
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (...args) => {
    const stream = await original(...args);
    window.__tracks.push(...stream.getTracks());
    return stream;
  };
});
const ended = () => page.evaluate(() => window.__tracks.length > 0 && window.__tracks.every((track) => track.readyState === "ended"));
const waitText = (text) => page.getByText(text, { exact: true }).waitFor();
// Feed the browser's actual normalized upload into the real HTTP handler.
await page.route("**/api/transcriptions", async (route) => {
  const incoming = route.request();
  const headers = { ...incoming.headers(), host: new URL(incoming.url()).host, origin: new URL(incoming.url()).origin };
  const response = await handleStt(new Request(incoming.url(), { method: "POST", headers, body: incoming.postDataBuffer() }));
  await route.fulfill({ status: response.status, contentType: "application/json", body: await response.text() });
});
try {
  await page.goto(`${process.env.BASE_URL || "http://localhost:3000"}/voice-input-test`);
  await page.getByRole("button", { name: "녹음 시작", exact: true }).click();
  await waitText("녹음 중이에요. 말을 마치면 종료를 눌러 주세요.");
  const diagnostics = page.getByRole("complementary", { name: "녹음 진단 (development)" });
  await diagnostics.waitFor();
  assert.match(await diagnostics.innerText(), /recordButtonClicked\s+true/);
  assert.match(await diagnostics.innerText(), /mediaRecorderStarted\s+true/);
  assert.match(await diagnostics.innerText(), /streamTrack\.readyState\s+live/);
  assert.match(await diagnostics.innerText(), /selectedMime\s+audio\/webm/);
  assert.match(await diagnostics.innerText(), /userActivation.isActive\s+true/);
  await page.waitForTimeout(1600); // Capture synthetic audio, not a user's microphone.
  await page.getByRole("button", { name: "녹음 종료", exact: true }).click();
  await waitText("인식된 문장을 확인하고 수정한 뒤 전송해 주세요.");
  assert.ok(await ended());
  assert.equal(await page.getByLabel("질문 확인·수정").inputValue(), "세종대왕은 왜 훈민정음을 만들었어요?");
  await page.getByText(/원본 녹음: audio\/webm.*전송 형식: WAV/).waitFor();
  assert.equal(adapterCalls, 1);
  await waitText("화면 연결 확인: 0회 전달");
  await page.getByLabel("질문 확인·수정").fill("훈민정음은 처음에 몇 글자였어요?");
  await page.getByRole("button", { name: "확인한 질문 전송", exact: true }).evaluate((button) => { button.click(); button.click(); });
  await waitText("화면 연결 확인: 1회 전달");
  await waitText("훈민정음은 처음에 몇 글자였어요?");
  console.log("PASS: real Chrome WebM -> decode/resample/PCM WAV -> HTTP handler -> Azure adapter, editable review, manual send, double-click protection");

  await page.getByRole("button", { name: "녹음 시작", exact: true }).click();
  await waitText("녹음 중이에요. 말을 마치면 종료를 눌러 주세요.");
  await page.waitForTimeout(1000);
  await page.getByRole("button", { name: "녹음 종료", exact: true }).click();
  await waitText("음성을 글로 바꾸는 중이에요.");
  while (adapterCalls < 2) await page.waitForTimeout(20);
  await page.getByRole("button", { name: "녹음·인식 취소", exact: true }).click();
  await page.waitForTimeout(900);
  assert.equal(await page.getByLabel("질문 확인·수정").inputValue(), "");
  assert.ok(await ended());
  console.log("PASS: cancellation while mock transcription is pending");

  await page.getByLabel("질문 확인·수정").fill("보존할 질문");
  await page.getByRole("button", { name: "녹음 시작", exact: true }).click();
  await page.getByRole("button", { name: "현재 글 유지", exact: true }).click();
  assert.equal(await page.getByLabel("질문 확인·수정").inputValue(), "보존할 질문");
  await page.getByRole("button", { name: "녹음 시작", exact: true }).click();
  await page.getByRole("button", { name: "바꾸고 녹음", exact: true }).click();
  await waitText("녹음 중이에요. 말을 마치면 종료를 눌러 주세요.");
  await page.getByRole("button", { name: "시험 초기화", exact: true }).click();
  assert.ok(await ended());
  assert.equal(await page.getByLabel("질문 확인·수정").inputValue(), "");
  console.log("PASS: replacement confirmation and session reset cleanup");

  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException("Denied", "NotAllowedError"); }; });
  await page.getByRole("button", { name: "녹음 시작", exact: true }).click();
  await waitText("마이크 권한이 허용되지 않았어요. 브라우저 설정을 확인하거나 글로 질문해 주세요.");
  assert.match(await diagnostics.innerText(), /error.name\s+NotAllowedError/);
  assert.match(await diagnostics.innerText(), /error.message\s+Denied/);
  assert.match(await diagnostics.innerText(), /errorStage\s+getUserMedia/);
  assert.doesNotMatch(await diagnostics.innerText(), /browser-boundary-test-key/);
  await page.getByLabel("질문 확인·수정").fill("글 입력은 계속 사용할 수 있어요");
  await page.getByRole("button", { name: "확인한 질문 전송", exact: true }).click();
  await waitText("화면 연결 확인: 1회 전달");
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.equal(apiCalls.length, 2);
  assert.ok(apiCalls.every((url) => new URL(url).pathname === "/api/transcriptions"));
  await page.getByLabel("전송 실패 시험").check();
  await page.getByLabel("질문 확인·수정").fill("실패해도 보존할 수정 문장");
  await page.getByRole("button", { name: "확인한 질문 전송", exact: true }).click();
  await waitText("질문을 전달하지 못했어요. 입력한 글은 유지했으니 다시 시도해 주세요.");
  assert.equal(await page.getByLabel("질문 확인·수정").inputValue(), "실패해도 보존할 수정 문장");
  assert.deepEqual(errors, []);
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
  console.log(`PASS: simulated denial, text fallback, 360px layout, failed send preserves edits, only explicit STT requests. Browser: ${browser.version()}`);
} finally {
  await browser.close();
  await rm(audioPath);
  await rmdir(temporary);
  globalThis.fetch = nativeFetch;
}
