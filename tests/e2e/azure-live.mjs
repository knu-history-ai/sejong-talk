// Explicit real-Azure browser integration test. Uses synthetic speech, no person microphone.
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import nextEnv from "@next/env";
import { chromiumRuntime } from "../helpers/browser-audio.mjs";
import { loadTs } from "../helpers/load-ts.mjs";
nextEnv.loadEnvConfig(process.cwd(), true);
const { inspectPcmWav } = loadTs("src/features/voice-input/pcm-wav.ts");
const report = { at: new Date().toISOString(), status: "NEEDS_ENV", source: "Chrome synthetic microphone, real Next route and Azure Short Audio REST; not a physical device test" };
if (process.env.AZURE_SPEECH_KEY?.trim() && process.env.AZURE_SPEECH_REGION?.trim() && process.env.STT_PROVIDER === "azure") {
  const chromium = await chromiumRuntime();
  const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${resolve("tests/fixtures/stt-korean-synthetic.wav")}`] });
  try {
    const page = await browser.newPage();
    let requests = 0;
    await page.route("**/api/transcriptions", async (route) => {
      requests++;
      const request = route.request();
      const form = await new Response(request.postDataBuffer(), { headers: { "Content-Type": request.headers()["content-type"] } }).formData();
      const wav = form.get("audio");
      assert.equal(wav.type, "audio/wav");
      report.upload = { mime: wav.type, bytes: wav.size, ...inspectPcmWav(await wav.arrayBuffer()) };
      await route.continue(); // Real running Next server -> real Azure endpoint.
    });
    await page.goto(`${process.env.BASE_URL || "http://localhost:3000"}/voice-input-test`);
    await page.getByRole("button", { name: "녹음 시작", exact: true }).click();
    await page.getByText("녹음 중이에요. 말을 마치면 종료를 눌러 주세요.", { exact: true }).waitFor();
    await page.waitForTimeout(4200);
    const responsePromise = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/transcriptions");
    await page.getByRole("button", { name: "녹음 종료", exact: true }).click();
    const response = await responsePromise;
    report.httpStatus = response.status();
    const result = await response.json();
    assert.equal(result.status, "completed", "Real Azure route did not complete; inspect the safe UI error.");
    await page.getByText("인식된 문장을 확인하고 수정한 뒤 전송해 주세요.", { exact: true }).waitFor();
    report.originalMime = "audio/webm;codecs=opus";
    await page.getByText(/원본 녹음: audio\/webm.*전송 형식: WAV/).waitFor();
    report.transcript = await page.getByLabel("질문 확인·수정").inputValue();
    assert.match(report.transcript, /[가-힣]/);
    await page.getByText("화면 연결 확인: 0회 전달", { exact: true }).waitFor();
    const edited = "훈민정음은 처음에 몇 글자였어요?";
    await page.getByLabel("질문 확인·수정").fill(edited);
    await page.getByRole("button", { name: "확인한 질문 전송", exact: true }).evaluate((button) => { button.click(); button.click(); });
    await page.getByText("화면 연결 확인: 1회 전달", { exact: true }).waitFor();
    await page.getByText(edited, { exact: true }).waitFor();
    assert.equal(requests, 1);
    report.status = "PASS"; report.editedText = edited; report.onConfirmCount = 1; report.transcriptionRequests = requests; report.browser = browser.version();
  } catch {
    report.status = "FAIL"; report.error = "실제 브라우저 전사/수정/전송 흐름을 확인하지 못했습니다.";
    process.exitCode = 1;
  } finally { await browser.close(); }
}
await writeFile("docs/STT_BROWSER_RESULT.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
