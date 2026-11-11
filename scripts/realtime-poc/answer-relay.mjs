// 실시간 음성 PoC: Speech Engine이 보낸 사용자 발화를 답변 생성기에 넘기고,
// 생성된 글 조각을 그대로 Speech Engine에 흘려보낸다(음성 합성은 ElevenLabs가 함).
//
// 답변 생성기 약속(정민님 Bedrock 연결부가 이 형식만 맞추면 됨):
//   export async function* answer({ transcript, signal }) { yield "글 조각"; ... }
//   - transcript: [{ role: "user" | "agent", content: string }] 전체 대화(마지막이 이번 사용자 말)
//   - signal: 사용자가 끼어들면 abort 됨 → Bedrock 스트림도 이 signal로 끊을 것
//
// 기록에는 시각·글자 수·상태만 남기고 대화 원문·키는 남기지 않는다.

const MOCK_REPLY = [
  "좋은 질문이구나. ",
  "지금은 음성 연결을 시험하는 중이라 미리 정해 둔 말로 답하고 있단다. ",
  "내 말이 끝나기 전에 말을 걸면, 하던 말을 멈추고 네 이야기를 다시 들을 것이니라.",
];

/** 사람이 들을 수 있을 만큼 천천히 나오는 고정 답변. 끼어들기 시험용으로 일부러 길게 둔다. */
export async function* mockAnswer({ signal, delayMs = 250 }) {
  for (const piece of MOCK_REPLY) {
    if (signal.aborted) return;
    await sleep(delayMs, signal);
    if (signal.aborted) return;
    yield piece;
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * 생성기를 감싸 끼어들기(abort) 때 즉시 멈추고, 지연·결과를 기록한다.
 * 반환값은 Speech Engine session.sendResponse()에 그대로 넣는다.
 */
export async function* relayAnswer({ transcript, signal, answer, log = () => {}, now = () => performance.now() }) {
  const startedAt = now();
  let firstChunkAt = null;
  let chunks = 0;
  let chars = 0;
  let outcome = "completed";
  try {
    for await (const piece of answer({ transcript, signal })) {
      if (signal.aborted) {
        outcome = "interrupted";
        return;
      }
      const text = typeof piece === "string" ? piece : "";
      if (!text) continue;
      if (firstChunkAt === null) firstChunkAt = now();
      chunks += 1;
      chars += text.length;
      yield text;
    }
    if (signal.aborted) outcome = "interrupted";
  } catch (error) {
    if (signal.aborted || error?.name === "AbortError") {
      outcome = "interrupted";
      return;
    }
    outcome = "failed";
    throw error;
  } finally {
    log({
      event: "answer",
      outcome,
      turns: Array.isArray(transcript) ? transcript.length : 0,
      firstChunkMs: firstChunkAt === null ? null : Math.round(firstChunkAt - startedAt),
      totalMs: Math.round(now() - startedAt),
      chunks,
      chars,
    });
  }
}

/** 마지막 사용자 발화가 비어 있으면 답하지 않는다(잡음·빈 인식). */
export function hasUserText(transcript) {
  const last = Array.isArray(transcript) ? transcript.at(-1) : undefined;
  return last?.role === "user" && typeof last.content === "string" && last.content.trim().length > 0;
}

/** REALTIME_POC_ANSWER_MODULE로 실제 생성기(예: Bedrock)를 갈아끼운다. 없으면 고정 답변. */
export async function loadAnswer(modulePath) {
  if (!modulePath) return mockAnswer;
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const loaded = await import(pathToFileURL(resolve(modulePath)).href);
  if (typeof loaded.answer !== "function") {
    throw new Error(`${modulePath} 에 answer({ transcript, signal }) 함수가 없습니다.`);
  }
  return loaded.answer;
}
