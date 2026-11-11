#!/usr/bin/env node
// 실시간 음성 PoC: ElevenLabs Speech Engine이 접속하는 WebSocket 서버.
//
// 구조: 브라우저 ⇄(WebRTC 음성) ElevenLabs Speech Engine ⇄(WebSocket 글) 이 서버 ⇄ 답변 생성기
//   - 음성 인식·말 끝 감지·음성 합성·끼어들기 감지는 ElevenLabs가 한다.
//   - 이 서버는 사용자 발화 글을 받아 답변 글을 스트리밍으로 돌려준다.
//   - 사용자가 끼어들면 SDK가 이전 답변의 signal을 abort → 생성기를 멈춘다.
//
// Next.js 라우트는 WebSocket 업그레이드를 받을 수 없어 별도 Node 프로세스로 띄운다.
// 실행: node --env-file-if-exists=.env.local scripts/realtime-poc/speech-engine-server.mjs
// 필요한 값: ELEVENLABS_API_KEY, ELEVENLABS_SPEECH_ENGINE_ID (seng_...)
// 선택 값: REALTIME_POC_WS_PORT(3001), REALTIME_POC_WS_PATH(/ws), REALTIME_POC_ANSWER_MODULE, REALTIME_POC_DEBUG=1

import { createServer } from "node:http";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { hasUserText, loadAnswer, relayAnswer } from "./answer-relay.mjs";

const apiKey = process.env.ELEVENLABS_API_KEY;
const engineId = process.env.ELEVENLABS_SPEECH_ENGINE_ID;
const port = Number(process.env.REALTIME_POC_WS_PORT || 3001);
const path = process.env.REALTIME_POC_WS_PATH || "/ws";
const debug = process.env.REALTIME_POC_DEBUG === "1";

if (!apiKey || !engineId) {
  console.error("ELEVENLABS_API_KEY 와 ELEVENLABS_SPEECH_ENGINE_ID 를 .env.local 에 넣어 주세요.");
  process.exit(1);
}

const answer = await loadAnswer(process.env.REALTIME_POC_ANSWER_MODULE);
const answerName = process.env.REALTIME_POC_ANSWER_MODULE || "mock(고정 답변)";

// 원문 없는 한 줄 JSON 기록. 키·대화 내용은 넣지 않는다.
const log = (record) => console.log(JSON.stringify({ at: new Date().toISOString(), ...record }));

const httpServer = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, path, answer: answerName.includes("mock") ? "mock" : "module" }));
    return;
  }
  res.writeHead(404).end();
});

const elevenlabs = new ElevenLabsClient({ apiKey });
// attach()가 X-Elevenlabs-Speech-Engine-Authorization JWT를 검증한다(disableAuth 쓰지 않음).
await elevenlabs.speechEngine.attach(engineId, httpServer, path, {
  debug,
  onInit(conversationId) {
    log({ event: "init", conversationId });
  },
  onTranscript(transcript, signal, session) {
    if (!hasUserText(transcript)) return;
    log({ event: "transcript", conversationId: session.conversationId, turns: transcript.length });
    signal.addEventListener(
      "abort",
      () => log({ event: "interrupted", conversationId: session.conversationId }),
      { once: true },
    );
    void session.sendResponse(
      relayAnswer({
        transcript,
        signal,
        answer,
        log: (record) => log({ ...record, conversationId: session.conversationId }),
      }),
    );
  },
  onClose(session) {
    log({ event: "close", conversationId: session.conversationId });
  },
  onDisconnect(session) {
    log({ event: "disconnected", conversationId: session.conversationId });
  },
  onError(error, session) {
    log({ event: "error", conversationId: session?.conversationId, message: error?.message });
  },
});

httpServer.listen(port, () => {
  console.log(`Speech Engine WebSocket 서버 준비: ws://localhost:${port}${path} (답변: ${answerName})`);
  console.log("외부에서 접속하려면 https 터널(예: cloudflared/ngrok) 주소를 Speech Engine ws_url 로 등록하세요.");
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => httpServer.close(() => process.exit(0)));
}
