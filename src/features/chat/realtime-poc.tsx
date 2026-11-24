"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useSpeechEngineVoice } from "@/features/realtime-voice/use-speech-engine-voice";
import { canStartVoice, VOICE_ERROR_MESSAGES, type VoicePhase } from "@/features/realtime-voice/voice-state";

const STATUS: Record<VoicePhase, string> = {
  idle: "대기 중", requestingMic: "마이크 확인 중", connecting: "연결 중",
  listening: "듣는 중", thinking: "답변 준비 중", speaking: "답변 중",
  ending: "종료 중", ended: "대화 종료", error: "연결 오류",
};

type AnswerMode = "mock" | "bedrock";

export function RealtimePoc({ voiceConfigured = false, answerMode = "mock" }: { voiceConfigured?: boolean; answerMode?: AnswerMode }) {
  const [revision, setRevision] = useState(0);
  return <VoiceConversation key={revision} voiceConfigured={voiceConfigured} answerMode={answerMode} onReset={() => setRevision((v) => v + 1)} />;
}

function VoiceConversation({ voiceConfigured, answerMode, onReset }: { voiceConfigured: boolean; answerMode: AnswerMode; onReset: () => void }) {
  const { state, start, stop } = useSpeechEngineVoice();
  const [confirmReset, setConfirmReset] = useState(false);
  const dialogue = useRef<HTMLDivElement>(null);
  const canStart = canStartVoice(state.phase);
  const error = state.error ? VOICE_ERROR_MESSAGES[state.error] : null;

  useEffect(() => {
    const log = dialogue.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [state.lines]);

  async function endConversation() {
    await stop();
    setConfirmReset(true);
  }

  return (
    <main className="sejong-app chat-page">
      <header className="site-header">
        <Link className="brand" href="/realtime-poc">
          <Image src="/images/logo-sejongtalk.png" alt="세종톡" width={1928} height={815} sizes="140px" />
        </Link>
      </header>
      <section className="chat-workspace">
        <div className="scene chat-scene">
          <Image src="/images/scene-chat.png" alt="궁궐 앞에서 인사하는 세종대왕" fill sizes="(max-width: 760px) 100vw, 28vw" />
          <span className="scene-badge">AI로 재구성한 세종대왕</span>
        </div>
        <div className="conversation-panel">
          <section className="conversation-card overflow-y-auto" aria-labelledby="poc-title">
            <div className="conversation-heading">
              <h1 id="poc-title">
                <Image src="/images/icon-chat.png" alt="" width={36} height={36} />
                세종대왕과 음성 대화
              </h1>
              <span className="sample-badge">음성 연결 시험 · {answerMode === "bedrock" ? "Haiku 답변" : "고정 답변"}</span>
            </div>
            <p className="mb-4 text-sm text-[var(--muted)]">{answerMode === "bedrock"
              ? "준비된 역사 자료를 바탕으로 답변하는 음성 대화 시험입니다. 듣는 중으로 바뀌면 말씀해 주세요."
              : "지금은 미리 정한 답변으로 음성 연결을 시험합니다. 역사 질문에 답하는 기능은 아직 연결하지 않았어요."}</p>
            <div className="dialogue min-h-36!" ref={dialogue} aria-label="음성 대화 기록" role="log" aria-live="polite">
              {state.lines.length === 0 && <p className="text-sm text-[var(--muted)]">대화를 시작하면 여기에 말한 내용과 답변이 표시됩니다.</p>}
              {state.lines.map((line, index) => (
                <div key={index} className={`message ${line.role === "user" ? "student-message" : "sejong-message"}`}>
                  {line.role === "agent" && <Image className="avatar" src="/images/avatar-sejong.png" alt="" width={48} height={48} />}
                  <div className="min-w-0">
                    <strong className="speaker-name">{line.role === "user" ? "나" : "세종대왕"}</strong>
                    <div className="answer-bubble"><p>{line.text}</p></div>
                  </div>
                  {line.role === "user" && <Image className="avatar" src="/images/avatar-student.png" alt="" width={48} height={48} />}
                </div>
              ))}
            </div>
            <div className="mt-6 rounded-lg border border-[var(--line)] p-4">
              <p className="font-bold text-[var(--navy)]" role="status">{voiceConfigured ? STATUS[state.phase] : "음성 연결 준비 중"}</p>
              {!voiceConfigured ? <p className="mt-2 text-sm text-[var(--muted)]">음성 서비스 설정을 마치면 대화를 시작할 수 있어요.</p>
                : <p className="mt-2 text-sm text-[var(--muted)]">답변이 나오는 중에 다시 말해 재생이 멈추는지 확인해 주세요.</p>}
              {error && <div className="answer-bubble error-bubble mt-3" role="alert"><strong>{error.title}</strong><p>{error.message}</p></div>}
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" className="primary-button" disabled={!voiceConfigured || !canStart || confirmReset} onClick={() => void start()}>대화 시작</button>
                <button type="button" className="outline-button" disabled={canStart || state.phase === "ending"} onClick={() => void endConversation()}>대화 종료</button>
              </div>
            </div>
            {confirmReset && <section className="mt-4 rounded-lg border border-[var(--line)] p-4" aria-labelledby="reset-poc-title">
              <h2 id="reset-poc-title" className="font-bold text-[var(--navy)]">대화가 끝났어요. 기록을 초기화할까요?</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="outline-button" onClick={() => setConfirmReset(false)}>기록 유지</button>
                <button type="button" className="primary-button" onClick={onReset}>초기화</button>
              </div>
            </section>}
            <details className="mt-5 border-t border-[var(--line)] pt-4">
              <summary className="cursor-pointer text-sm font-bold text-[var(--navy)]">시험 기록</summary>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
                <dt>끼어들기 이벤트</dt><dd>{state.interruptions}회</dd>
                <dt>메시지 수신 → 답변 상태 변경</dt><dd>{state.timing.lastResponseLatencyMs === null ? "미측정" : `${state.timing.lastResponseLatencyMs}ms`}</dd>
              </dl>
              <p className="mt-2 text-xs text-[var(--muted)]">위 시간은 실제 발화 종료부터 첫 소리까지의 시간이 아닙니다.</p>
            </details>
          </section>
        </div>
      </section>
    </main>
  );
}
