// Explicit Azure Short Audio REST smoke test. Never imported by npm test.
import { writeFile } from "node:fs/promises";
import { loadTs } from "./helpers/load-ts.mjs";
import { normalizeFixture } from "./helpers/browser-audio.mjs";
import nextEnv from "@next/env";
nextEnv.loadEnvConfig(process.cwd(), true);
const { recognizeAzure } = loadTs("src/server/stt/azure.ts");
const { SttError } = loadTs("src/server/stt/common.ts");
const { inspectPcmWav } = loadTs("src/features/voice-input/pcm-wav.ts");
const { evaluate } = loadTs("src/features/voice-input/evaluation.ts");
const reference = "세종대왕은 왜 훈민정음을 만들었나요?";
const report = { at: new Date().toISOString(), provider: "azure", api: "Short Audio REST; language=ko-KR; format=detailed", source: "Existing 22.05kHz Korean synthetic WAV normalized through production browser code", resourceTier: "Not queried; endpoint supports F0", reference, status: "NEEDS_ENV", httpSuccess: false, recognitionStatus: null, displayText: null, latencyMs: null, evaluation: null };
if (process.env.AZURE_SPEECH_KEY?.trim() && process.env.AZURE_SPEECH_REGION?.trim()) {
  try {
    const audio = await normalizeFixture("tests/fixtures/stt-korean-synthetic.wav");
    report.audio = { mime: audio.type, bytes: audio.size, ...inspectPcmWav(await audio.arrayBuffer()) };
    const start = performance.now();
    try {
      const result = await recognizeAzure(audio, new AbortController().signal);
      report.status = "PASS"; report.httpSuccess = true; report.httpStatus = result.httpStatus;
      report.recognitionStatus = result.recognitionStatus; report.displayText = result.text; report.evaluation = evaluate(reference, result.text);
    } finally { report.latencyMs = Math.round(performance.now() - start); }
  } catch (error) {
    report.status = "FAIL"; report.httpStatus = error instanceof SttError ? error.httpStatus ?? null : null;
    report.error = error instanceof SttError ? error.message : "연결 또는 오디오 준비 실패. 환경과 네트워크를 확인하세요.";
    process.exitCode = 1;
  }
}
await writeFile("docs/STT_SMOKE_RESULT.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
