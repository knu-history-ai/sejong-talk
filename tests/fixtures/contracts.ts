import type {
  Answer, Character, Fact, Source, PromptExample, EvalCase, EvalResult,
  CreateSessionRequest, CreateSessionResponse, DeleteSessionResponse,
  TurnRequest, SpeechRequest, RequestState, ErrorResponse,
} from "../../src/contracts";

// All fixtures are synthetic development data, not reviewed production content.
export const character = {
  id: "sejong", name: "세종", intro: "궁금한 것을 물어보거라.",
  personaVersion: "fixture-persona-v1", policyVersion: "fixture-policy-v1",
} satisfies Character;
export const source = {
  id: "source_fixture_01", title: "훈민정음 자료 (개발용 연결 예시)",
  institution: "샘플 기관", url: "https://example.org/history/fixture",
  locator: "샘플 문단", checkedAt: null,
} satisfies Source;
export const fact = {
  id: "fact_fixture_01", characterId: character.id, topic: "훈민정음",
  text: "훈민정음은 처음에 28자로 만들어졌다.", sourceIds: [source.id],
  reviewStatus: "pending",
} satisfies Fact;
export const turnRequest = {
  requestId: "turn_fixture_01", text: "훈민정음은 처음에 몇 글자였어요?",
} satisfies TurnRequest;
export const sourceView = {
  id: source.id, title: source.title, institution: source.institution, url: source.url,
};
// Wire-format sample only: pending fact above must NOT enter real grounded answers.
export const groundedAnswer = {
  answerId: "answer_fixture_01", kind: "grounded",
  text: "훈민정음은 처음에 스물여덟 글자였단다.",
  factIds: [fact.id], sources: [sourceView],
  personaVersion: character.personaVersion, contentVersion: "fixture-content-v1",
} satisfies Answer;
export const answers = {
  grounded: groundedAnswer,
  conversation: { ...groundedAnswer, answerId: "answer_fixture_02", kind: "conversation", text: "반갑구나. 무엇이 궁금하니?", factIds: [], sources: [] },
  insufficient: { ...groundedAnswer, answerId: "answer_fixture_03", kind: "insufficient", text: "그 부분은 지금 준비된 자료로 확인하기 어렵구나.", factIds: [], sources: [] },
  fallback: { ...groundedAnswer, answerId: "answer_fixture_04", kind: "fallback", text: "이번 답변은 확인을 마치지 못했구나. 다른 질문으로 다시 이야기해 보자.", factIds: [], sources: [] },
} satisfies Record<string, Answer>;
export const sessionRequest = { characterId: character.id } satisfies CreateSessionRequest;
export const sessionCreated = {
  status: "created", sessionId: "session_fixture_01", characterId: character.id,
  expiresAt: "2099-01-01T00:30:00Z", intro: character.intro,
  suggestedQuestions: [turnRequest.text],
} satisfies CreateSessionResponse;
export const sessionDeleted = { status: "deleted" } satisfies DeleteSessionResponse;
export const speechRequest = {
  requestId: "speech_fixture_01", answerId: groundedAnswer.answerId,
} satisfies SpeechRequest;
export const responses = {
  queued: { requestId: turnRequest.requestId, operation: "turn", status: "queued" },
  processing: { requestId: turnRequest.requestId, operation: "turn", status: "processing" },
  grounded: { requestId: turnRequest.requestId, operation: "turn", status: "approved", answer: answers.grounded },
  conversation: { requestId: "turn_fixture_02", operation: "turn", status: "approved", answer: answers.conversation },
  insufficient: { requestId: "turn_fixture_03", operation: "turn", status: "approved", answer: answers.insufficient },
  fallback: { requestId: "turn_fixture_04", operation: "turn", status: "approved", answer: answers.fallback },
  transcription: { requestId: "stt_fixture_01", operation: "transcription", status: "completed", text: turnRequest.text },
  speech: { requestId: speechRequest.requestId, operation: "speech", status: "completed", answerId: speechRequest.answerId, audio: { url: "/api/speech/audio/answer_fixture_01", mimeType: "audio/wav", expiresAt: sessionCreated.expiresAt } },
  cancelled: { requestId: "turn_fixture_cancelled", operation: "turn", status: "cancelled" },
  timeout: { requestId: "turn_fixture_timeout", operation: "turn", status: "failed", code: "UPSTREAM_TIMEOUT", message: "응답이 늦어지고 있어요. 다시 시도해 주세요.", retryable: true },
} satisfies Record<string, RequestState>;
export const errors = {
  expired: { status: "failed", requestId: turnRequest.requestId, code: "SESSION_EXPIRED", message: "대화가 만료됐어요. 새 대화를 시작해 주세요.", retryable: false },
  invalid: { status: "failed", requestId: null, code: "INVALID_INPUT", message: "질문을 확인해 주세요.", retryable: false },
  limit: { status: "failed", requestId: turnRequest.requestId, code: "LIMIT_EXCEEDED", message: "잠시 뒤 다시 시도해 주세요.", retryable: true, retryAfterSeconds: 30 },
} satisfies Record<string, ErrorResponse>;
export const promptExample = { characterId: character.id, question: turnRequest.text, desiredBehavior: "검토된 사실 카드로 설명한다." } satisfies PromptExample;
export const evalCase = { id: "eval_fixture_01", characterId: character.id, category: "fact", input: turnRequest.text, expectedFacts: [fact.id], failureConditions: ["처음부터 24자였다고 답함"] } satisfies EvalCase;
export const evalResult = { caseId: evalCase.id, runId: "run_fixture_01", model: "mock-no-provider", personaVersion: character.personaVersion, contentVersion: groundedAnswer.contentVersion, evaluatedAt: "2026-09-19T00:00:00Z", verdict: "needs_review", notes: "형식 예시이며 실제 평가 결과가 아닙니다." } satisfies EvalResult;

/** Synthetic 100ms silence for testing playback plumbing, not a TTS quality sample. */
export function createPlaybackFixture(): Blob {
  const bytes = new ArrayBuffer(44 + 1600);
  const view = new DataView(bytes);
  const write = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  write(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true);
  write(8, "WAVE"); write(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 16000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, 1600, true);
  return new Blob([bytes], { type: "audio/wav" });
}
