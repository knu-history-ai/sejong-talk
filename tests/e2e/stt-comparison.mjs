import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { loadTs } from "../helpers/load-ts.mjs";
const { inspectPcmWav } = loadTs("src/features/voice-input/pcm-wav.ts");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = []; page.on("pageerror", (error) => errors.push(error.message));
let calls = 0;
await page.route("**/api/dev/stt-compare", async (route) => {
  calls++;
  const request = route.request();
  const form = await new Response(request.postDataBuffer(), { headers: { "Content-Type": request.headers()["content-type"] } }).formData();
  const wav = form.get("audio");
  assert.equal(wav.type, "audio/wav");
  assert.equal(inspectPcmWav(await wav.arrayBuffer()).sampleRate, 16000);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await route.fulfill({ contentType: "application/json", body: JSON.stringify({ results: ["azure", "clova", "deepgram", "groq", "elevenlabs"].map((provider) => ({ provider, text: provider === "clova" ? "" : "세종대왕은 왜 훈민정음을 만들었나요?", success: provider !== "clova", latencyMs: 123, error: provider === "clova" ? "설정 필요: CLOVA_SPEECH_INVOKE_URL" : undefined })) }) });
});
try {
  await page.goto(`${process.env.BASE_URL || "http://127.0.0.1:3000"}/dev/stt-test`);
  await page.getByLabel("기존 음성 파일").setInputFiles("tests/fixtures/stt-korean-synthetic.wav");
  await page.getByRole("button", { name: "파일로 5개 STT 비교" }).evaluate((button) => { button.click(); button.click(); });
  await page.getByText("설정 필요: CLOVA_SPEECH_INVOKE_URL", { exact: true }).waitFor();
  assert.equal(calls, 1); assert.equal(await page.locator("tbody tr").count(), 5);
  assert.equal(await page.getByRole("cell", { name: "성공", exact: true }).count(), 4);
  assert.equal(await page.getByRole("cell", { name: "0.0%", exact: true }).count(), 8);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "결과 JSON 내려받기" }).click();
  assert.equal((await download).suggestedFilename(), "stt-comparison.json");
  await page.getByLabel("기존 음성 파일").setInputFiles({ name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("not a valid recording") });
  await page.getByRole("button", { name: "파일로 5개 STT 비교" }).click();
  await page.getByText("파일이 손상되었거나 이 브라우저에서 읽을 수 없는 형식이에요.", { exact: true }).waitFor(); assert.equal(calls, 1);
  assert.equal(await page.locator("tbody tr").count(), 5);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "docs/stt-comparison-preview.png", fullPage: true });
  console.log("PASS: comparison upload, duplicate-click prevention, partial failure isolation, CER/terms, JSON export, damaged audio, mobile layout");
} finally { await browser.close(); }
