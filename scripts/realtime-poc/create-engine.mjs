#!/usr/bin/env node
// 실시간 음성 PoC: 한국어 Speech Engine을 만들거나 설정을 갱신한다.
// 기본은 미리보기(아무 호출도 하지 않음). 실제 생성·갱신은 --apply를 붙여야 한다.
//
//   미리보기: node --env-file-if-exists=.env.local scripts/realtime-poc/create-engine.mjs --ws-url=wss://<터널주소>/ws
//   새로 생성: ... --ws-url=wss://<터널주소>/ws --apply
//   기존 갱신: ... --ws-url=wss://<터널주소>/ws --update=seng_xxx --apply
//
// 생성 결과의 speech_engine_id(seng_...)를 .env.local의 ELEVENLABS_SPEECH_ENGINE_ID에 넣는다.

import { pathToFileURL } from "node:url";

/** 화면이 듣는 중/답변 중/끼어들기를 알 수 있도록 꼭 켜야 하는 이벤트 */
export const REQUIRED_CLIENT_EVENTS = ["conversation_initiation_metadata", "audio", "interruption", "user_transcript", "agent_response", "ping"];

export function buildEngineConfig({ wsUrl, env = process.env }) {
  const url = new URL(wsUrl);
  if (url.protocol !== "wss:") throw new Error("ws_url은 wss:// 주소여야 합니다(ElevenLabs가 외부에서 접속).");
  const config = {
    name: "sejong-talk realtime PoC (ko)",
    speechEngine: { wsUrl: url.href },
    language: "ko",
    tts: {
      // 한국어를 지원하는 저지연 모델. 시연님 #95 음질 비교 결과에 따라 바꿀 수 있다.
      modelId: env.REALTIME_POC_TTS_MODEL || "eleven_flash_v2_5",
      ...(env.ELEVENLABS_VOICE_ID ? { voiceId: env.ELEVENLABS_VOICE_ID } : {}),
    },
    conversation: {
      maxDurationSeconds: 300,
      clientEvents: REQUIRED_CLIENT_EVENTS,
    },
    // 음성 원본 비보관(기존 STT의 원음 비보관 원칙과 맞춤)
    privacy: { recordVoice: false },
    callLimits: { agentConcurrencyLimit: 2, dailyLimit: 50 },
    tags: ["sejong-talk", "poc"],
  };
  return config;
}

function parseArgs(argv) {
  const args = Object.fromEntries(
    argv.filter((a) => a.startsWith("--")).map((a) => {
      const [key, ...rest] = a.slice(2).split("=");
      return [key, rest.length ? rest.join("=") : true];
    }),
  );
  return { wsUrl: args["ws-url"], update: args.update, apply: args.apply === true };
}

async function main() {
  const { wsUrl, update, apply } = parseArgs(process.argv.slice(2));
  if (!wsUrl) {
    console.error("--ws-url=wss://<공개 주소>/ws 를 지정해 주세요.");
    process.exit(1);
  }
  const config = buildEngineConfig({ wsUrl });
  console.log(JSON.stringify(config, null, 2));
  if (!apply) {
    console.log("\n미리보기만 했습니다. 실제로 만들려면 --apply 를 붙이세요.");
    return;
  }
  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    console.error("ELEVENLABS_API_KEY 가 없습니다(.env.local).");
    process.exit(1);
  }
  const { ElevenLabsClient } = await import("@elevenlabs/elevenlabs-js");
  const client = new ElevenLabsClient({ apiKey });
  const engine = update
    ? await client.speechEngine.update(update, config)
    : await client.speechEngine.create(config);
  console.log(`\n완료: ${engine.engineId}`);
  console.log("language:", engine.config?.language ?? "(응답 없음)", "/ tts:", engine.config?.tts?.modelId ?? "(응답 없음)");
  console.log(".env.local 에 ELEVENLABS_SPEECH_ENGINE_ID=" + engine.engineId + " 를 넣으세요.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error("실패:", error?.statusCode ?? "", error?.message ?? error);
    process.exit(1);
  });
}
