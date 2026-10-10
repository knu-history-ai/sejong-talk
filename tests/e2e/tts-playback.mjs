// Optional Chrome UI check; only speech HTTP responses are mocked, never calls Azure.
// Use PLAYWRIGHT_MODULE for an existing Playwright installation and BASE_URL for Next dev.
import assert from "node:assert/strict";
import { chromiumRuntime } from "../helpers/browser-audio.mjs";

const samples = 16000 * 3;
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF"); wav.writeUInt32LE(36 + samples * 2, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);

const chromium = await chromiumRuntime();
const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.ttsUrls = new Set();
    window.ttsUrlCount = 0;
    const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = (blob) => {
      const url = create(blob);
      window.ttsUrls.add(url);
      window.ttsUrlCount += 1;
      return url;
    };
    URL.revokeObjectURL = (url) => { window.ttsUrls.delete(url); revoke(url); };
  });
  let mode = "success", posts = 0, downloads = 0, releaseLate, downloaded;
  // Capture every speech path so this check cannot reach the real synthesis route.
  await page.route("**/api/speech**", async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      posts += 1;
      const input = req.postDataJSON();
      assert.deepEqual(Object.keys(input).sort(), ["answerId", "requestId"]);
      assert.equal(input.answerId, "tts_test_greeting");
      if (mode === "expired" || mode === "failed") {
        return route.fulfill({ status: mode === "expired" ? 401 : 503, json: {
          status: "failed", code: mode === "expired" ? "SESSION_EXPIRED" : "UNAVAILABLE",
          requestId: input.requestId, retryable: mode !== "expired",
          message: mode === "expired" ? "대화가 만료되었습니다." : "음성 합성 서비스를 사용할 수 없습니다.",
        } });
      }
      return route.fulfill({ json: {
        ...input, operation: "speech", status: "completed",
        audio: { url: "/api/speech/audio/tts_test_greeting", mimeType: "audio/wav", expiresAt: new Date(Date.now() + 60000).toISOString() },
      } });
    }
    assert.equal(req.method(), "GET");
    downloads += 1;
    if (mode === "late") {
      downloaded();
      await new Promise((resolve) => { releaseLate = resolve; });
    }
    try { await route.fulfill({ contentType: "audio/wav", body: wav }); }
    catch { /* Reset may already have aborted this intercepted request. */ }
  });

  await page.goto(`${process.env.BASE_URL || "http://127.0.0.1:3000"}/dev/tts-test`);
  const azure = page.getByRole("region", { name: "Azure 음성 시험", exact: true });
  const start = azure.getByRole("button", { name: "시험 대화 시작", exact: true });
  const reset = azure.getByRole("button", { name: "시험 대화 초기화", exact: true });
  const listen = azure.getByRole("button", { name: "답변 듣기", exact: true });
  const stop = azure.getByRole("button", { name: "정지", exact: true });
  const replay = azure.getByRole("button", { name: "다시 듣기", exact: true });
  await start.click();
  await azure.getByText("반갑구나. 무엇이 궁금하니?", { exact: true }).waitFor();
  await listen.click();
  await azure.getByText("답변 음성을 재생하고 있어요.", { exact: true }).waitFor();
  await azure.getByRole("button", { name: "1.2배", exact: true }).click();
  await stop.click();
  await replay.click();
  await azure.getByText("답변 음성을 재생하고 있어요.", { exact: true }).waitFor();
  assert.equal(posts, 1);
  assert.equal(downloads, 1);
  await reset.click();
  await start.waitFor({ state: "visible" });
  await page.waitForFunction(() => window.ttsUrls.size === 0);

  mode = "expired";
  await start.click();
  await listen.click();
  await azure.getByText("시험 대화를 새로 시작해 주세요.", { exact: true }).waitFor();
  assert.equal(await listen.isDisabled(), true);

  mode = "failed";
  await start.click();
  await listen.click();
  await azure.getByText("음성 합성 서비스를 사용할 수 없습니다.", { exact: true }).waitFor();
  mode = "success";
  await listen.click();
  await azure.getByText("답변 음성을 재생하고 있어요.", { exact: true }).waitFor();
  await reset.click();
  await page.waitForFunction(() => window.ttsUrls.size === 0);

  mode = "late";
  const ready = new Promise((resolve) => { downloaded = resolve; });
  await start.click();
  const urlsBefore = await page.evaluate(() => window.ttsUrlCount);
  const postsBefore = posts;
  await listen.evaluate((button) => { button.click(); button.click(); });
  await ready;
  assert.equal(posts, postsBefore + 1);
  const downloadsBefore = downloads;
  await reset.click();
  releaseLate();
  await start.click(); // New session must not inherit the previous audio response.
  await azure.getByText("반갑구나. 무엇이 궁금하니?", { exact: true }).waitFor();
  assert.equal(downloads, downloadsBefore);
  assert.equal(await page.evaluate(() => window.ttsUrlCount), urlsBefore);
  await azure.getByText("답변 듣기를 눌러 주세요.", { exact: true }).waitFor();
  assert.equal(await azure.getByRole("button", { name: "1.0배", exact: true }).getAttribute("aria-pressed"), "true");
  const stoppedDownload = new Promise((resolve) => { downloaded = resolve; });
  await listen.click();
  await stoppedDownload;
  await stop.click();
  releaseLate();
  await azure.getByText("답변 듣기를 눌러 주세요.", { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.ttsUrlCount), urlsBefore);
  await reset.click();
  await page.waitForFunction(() => window.ttsUrls.size === 0);
  assert.deepEqual(errors, []);
  console.log("PASS: API download/play/stop/replay/speed, error retry, session expiry, reset, stale audio and URL cleanup (mock speech, real dev sessions)");
} finally {
  await browser.close();
}
