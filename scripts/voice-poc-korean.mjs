import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fixtures from "../tests/fixtures/voice-poc-korean.json" with { type: "json" };
import { koreanPocSpeechRequest, PocSpeechError, requestKoreanPocSpeech } from "../src/server/tts/elevenlabs-poc.ts";

if (!process.argv.includes("--live")) throw new Error("실제 호출은 --live를 지정해야 합니다. 이 도구는 유료 API를 호출합니다.");
const caseId = process.argv.find((arg) => arg.startsWith("--case="))?.slice(7);
const selected = caseId ? fixtures.filter((item) => item.id === caseId) : fixtures;
if (!selected.length) throw new Error("알 수 없는 공통 문장 ID입니다.");
const config = koreanPocSpeechRequest(selected[0].text);
const configuration = { workspaceId: process.env.ELEVENLABS_WORKSPACE_ID?.trim() || null,
  voiceId: config.voiceId, model: config.model, language: config.body.language_code,
  voiceSettings: config.body.voice_settings, outputFormat: "mp3_44100_128" };
const revision = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8", cwd: fileURLToPath(new URL("../", import.meta.url)),
}).trim();
const runId = `voice-poc_${new Date().toISOString().replaceAll(":", "-")}_${randomUUID().slice(0, 8)}`;
const dir = new URL(`../private/voice-poc/${runId}/`, import.meta.url);
await mkdir(dir, { recursive: true });
const results = [];
for (const fixture of selected) {
  try {
    const result = await requestKoreanPocSpeech(fixture.text, { requestId: `${runId}_${fixture.id}` });
    const filename = `${fixture.id}.mp3`;
    await writeFile(new URL(filename, dir), result.audio, { flag: "wx" });
    results.push({ caseId: fixture.id, model: result.model, filename, bytes: result.audio.byteLength,
      timing: result.timing, playbackStartedAt: null, perceivedLatencyMs: null, quality: null, interruption: null, estimatedCostUsd: null });
  } catch (error) {
    if (!(error instanceof PocSpeechError)) throw error;
    results.push({ caseId: fixture.id, timing: error.timing, estimatedCostUsd: null });
  }
  // Persist each completed/failed attempt; a later failed call does not erase prior measurements.
  await writeFile(new URL("results.json", dir), `${JSON.stringify({ runId, configuration, revision,
    note: "고정 응답 TTS 계측. STT/LLM/브라우저 재생·음질·끼어들기·전체 응답 지연은 미측정.", results }, null, 2)}\n`);
}
console.log(`결과: ${fileURLToPath(dir)}`);
