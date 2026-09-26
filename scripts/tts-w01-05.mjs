import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";

const PROVIDERS = ["azure", "elevenlabs"];
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, ...value] = arg.replace(/^--/, "").split("=");
    return [key, value.join("=") || true];
  }),
);

if (args.help || !args.provider || !PROVIDERS.includes(args.provider)) {
  console.log(
    "사용법: npm run tts:evaluate -- --provider=azure|elevenlabs [--case=historical-terms] [--out=경로]",
  );
  process.exit(args.help ? 0 : 1);
}

const fixturesPath = path.resolve("tests/fixtures/tts-w01-05.json");
const fixtures = JSON.parse(await readFile(fixturesPath, "utf8"));
const selected = args.case
  ? fixtures.filter((item) => item.id === args.case)
  : fixtures;

if (selected.length === 0) {
  throw new Error(`알 수 없는 테스트 문장: ${args.case}`);
}

const outputDir = path.resolve(
  args.out === true || !args.out
    ? `evals/sejong/w01-05-results/${args.provider}`
    : args.out,
);
await mkdir(outputDir, { recursive: true });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} 환경변수가 필요합니다.`);
  return value;
}

function escapeXml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

async function requestAzure(text) {
  const region = required("AZURE_SPEECH_REGION");
  const voice = process.env.AZURE_TTS_VOICE || "ko-KR-InJoonNeural";
  const response = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": required("AZURE_SPEECH_KEY"),
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "SejongTalk-TTS-Evaluation",
      },
      body: `<speak version="1.0" xml:lang="ko-KR"><voice name="${voice}"><prosody rate="-5%" pitch="-1st">${escapeXml(text)}</prosody></voice></speak>`,
    },
  );
  return { response, extension: "mp3" };
}

async function requestElevenLabs(text) {
  const voiceId = required("ELEVENLABS_VOICE_ID");
  const modelId = process.env.ELEVENLABS_TTS_MODEL || "eleven_multilingual_v2";
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=mp3_44100_128`,
    {
      method: "POST",
      headers: {
        "xi-api-key": required("ELEVENLABS_API_KEY"),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: modelId,
        voice_settings: {
          stability: 0.65,
          similarity_boost: 0.75,
          style: 0.15,
          use_speaker_boost: true,
          speed: 0.95,
        },
      }),
    },
  );
  return { response, extension: "mp3" };
}

const requests = {
  azure: requestAzure,
  elevenlabs: requestElevenLabs,
};

const results = [];
for (const fixture of selected) {
  const startedAt = performance.now();
  const result = await requests[args.provider](fixture.text);
  const apiLatencyMs = Math.round(performance.now() - startedAt);

  if (!result.response.ok) {
    const errorBody = await result.response.text();
    throw new Error(
      `${fixture.id}: HTTP ${result.response.status} ${errorBody.slice(0, 300)}`,
    );
  }

  const audio = result.audio || Buffer.from(await result.response.arrayBuffer());
  const filename = `${fixture.id}.${result.extension}`;
  await writeFile(path.join(outputDir, filename), audio);
  results.push({
    id: fixture.id,
    category: fixture.category,
    characters: fixture.text.length,
    apiLatencyMs,
    bytes: audio.byteLength,
    filename,
    listenFor: fixture.listenFor,
    humanScores: {
      pronunciation: null,
      historicalFit: null,
      childClarity: null,
      naturalness: null,
      notes: "",
    },
  });
  console.log(`${fixture.id}: ${apiLatencyMs} ms, ${audio.byteLength} bytes`);
}

const report = {
  provider: args.provider,
  generatedAt: new Date().toISOString(),
  latencyDefinition: "요청 직전부터 전체 오디오 응답 수신까지의 시간",
  results,
};
await writeFile(
  path.join(outputDir, "results.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(`결과: ${outputDir}`);
