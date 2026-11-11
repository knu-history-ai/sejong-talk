"use client";

import { useSpeechEngineVoice } from "./use-speech-engine-voice";
import { VOICE_ERROR_MESSAGES, canStartVoice, type VoicePhase } from "./voice-state";

const PHASE_LABEL: Record<VoicePhase, string> = {
  idle: "대기 중",
  requestingMic: "마이크 확인 중",
  connecting: "연결 중",
  listening: "듣는 중",
  thinking: "답변 준비 중",
  speaking: "답변 중",
  ending: "종료 중",
  ended: "대화 종료",
  error: "오류",
};

/**
 * 음성 연결 담당 시험 화면. 실제 서비스 화면은 #93/PR #94(/realtime-poc)이며,
 * 이 화면은 Speech Engine 연결·마이크·끼어들기만 확인하려고 둔다.
 */
export function RealtimeVoiceTest() {
  const { state, start, stop } = useSpeechEngineVoice();
  const error = state.error ? VOICE_ERROR_MESSAGES[state.error] : null;
  const canStart = canStartVoice(state.phase);
  const t = state.timing;

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold">실시간 음성 연결 시험</h1>
      <p className="text-sm text-neutral-600">
        대화 시작 → 말하기 → 세종 답변이 나오는 중에 다시 말해서 답변이 멈추는지 확인합니다.
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          className="rounded bg-neutral-900 px-4 py-2 text-white disabled:opacity-40"
          onClick={() => void start()}
          disabled={!canStart}
        >
          대화 시작
        </button>
        <button
          type="button"
          className="rounded border px-4 py-2 disabled:opacity-40"
          onClick={() => void stop()}
          disabled={canStart && state.phase !== "error"}
        >
          대화 종료
        </button>
      </div>

      <p role="status" aria-live="polite" className="text-lg font-medium">
        상태: {PHASE_LABEL[state.phase]}
      </p>

      {error && (
        <div role="alert" className="rounded border border-red-300 bg-red-50 p-3">
          <p className="font-semibold">{error.title}</p>
          <p className="text-sm">{error.message}</p>
        </div>
      )}

      <ol className="flex flex-col gap-2">
        {state.lines.map((line, index) => (
          <li key={index} className={line.role === "user" ? "self-end rounded bg-blue-50 p-2" : "rounded bg-neutral-100 p-2"}>
            <span className="mr-2 text-xs text-neutral-500">{line.role === "user" ? "나" : "세종"}</span>
            {line.text}
          </li>
        ))}
      </ol>

      <dl className="grid grid-cols-2 gap-1 text-sm text-neutral-700">
        <dt>연결까지</dt>
        <dd>{t.startedAt !== null && t.connectedAt !== null ? `${Math.round(t.connectedAt - t.startedAt)}ms` : "-"}</dd>
        <dt>말 끝 → 첫 답변 음성</dt>
        <dd>{t.lastResponseLatencyMs !== null ? `${t.lastResponseLatencyMs}ms` : "-"}</dd>
        <dt>끼어들기 횟수</dt>
        <dd>{state.interruptions}</dd>
        <dt>대화 ID</dt>
        <dd className="truncate">{state.conversationId ?? "-"}</dd>
      </dl>
    </main>
  );
}
