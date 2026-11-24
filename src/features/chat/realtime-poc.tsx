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

function statusHint(phase: VoicePhase) {
  switch (phase) {
    case "requestingMic": return "마이크 권한을 확인하고 있어요.";
    case "connecting": return "세종대왕과 연결하고 있어요. 잠시만 기다려 주세요.";
    case "listening": return "잘 듣고 있어요. 편하게 말씀해 주세요.";
    case "thinking": return "말씀하신 내용을 바탕으로 답변을 준비하고 있어요.";
    case "speaking": return "세종대왕이 답변하고 있어요. 중간에 말씀하시면 끼어들 수 있어요.";
    case "ending": return "대화를 마무리하고 있어요.";
    case "ended": return "대화가 끝났어요.";
    case "error": return "연결 상태를 확인하고 다시 시도해 주세요.";
    default: return "대화 시작을 누르면 세종대왕과 음성 대화를 시작해요.";
  }
}

export function RealtimePoc({ voiceConfigured = false }: { voiceConfigured?: boolean }) {
  const [started, setStarted] = useState(false);
  const [revision, setRevision] = useState(0);
  if (!started) return <Introduction onStart={() => setStarted(true)} />;
  return <VoiceConversation key={revision} voiceConfigured={voiceConfigured} onHome={() => setStarted(false)} onReset={() => setRevision((v) => v + 1)} />;
}

function Introduction({ onStart }: { onStart: () => void }) {
  return <main className="sejong-app intro-page">
    <header className="site-header">
      <Link className="brand" href="/realtime-poc" aria-label="세종톡 첫 화면">
        <Image src="/images/logo-sejongtalk.png" alt="세종톡" width={1928} height={815} sizes="140px" priority />
      </Link>
    </header>
    <section className="intro-hero">
      <div className="scene intro-scene">
        <Image src="/images/scene-intro.png" alt="궁궐 앞에서 책을 들고 인사하는 세종대왕" fill sizes="(max-width: 760px) 100vw, 47vw" priority />
        <span className="scene-badge">세종대왕과 함께하는 역사 이야기</span>
      </div>
      <div className="intro-copy realtime-intro-copy">
        <p className="eyebrow"><Image className="chat-icon" src="/images/icon-chat.png" alt="" width={36} height={36} />역사 속 인물과 나누는 대화</p>
        <h1>세종대왕과<br /><em>이야기</em>해 볼까요?</h1>
        <p className="intro-description">궁금한 것을 말해 보세요.<br />세종대왕과 음성으로 이야기를 나눌 수 있어요.</p>
        <button type="button" className="primary-button start-button" onClick={onStart}>세종대왕 만나기 <svg className="line-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></button>
      </div>
    </section>
  </main>;
}

function VoiceConversation({ voiceConfigured, onHome, onReset }: { voiceConfigured: boolean; onHome: () => void; onReset: () => void }) {
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
        <button type="button" className="brand" aria-label="첫 화면으로" onClick={onHome}>
          <Image src="/images/logo-sejongtalk.png" alt="세종톡" width={1928} height={815} sizes="140px" />
        </button>
      </header>
      <section className="chat-workspace">
        <div className="scene chat-scene">
          <Image src="/images/scene-chat.png" alt="궁궐 앞에서 인사하는 세종대왕" fill sizes="(max-width: 760px) 100vw, 28vw" />
          <span className="scene-badge">AI로 재구성한 세종대왕</span>
        </div>
        <div className="conversation-panel">
          <section className="conversation-card realtime-card" aria-labelledby="realtime-title">
            <div className="conversation-heading">
              <h1 id="realtime-title">
                <Image src="/images/icon-chat.png" alt="" width={36} height={36} />
                세종대왕과 음성 대화
              </h1>
            </div>
            <div className="dialogue min-h-36!" ref={dialogue} aria-label="음성 대화 기록" role="log" aria-live="polite">
              {state.lines.length === 0 && <div className="poc-empty-state">
                <span className="poc-empty-mic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11v1a7 7 0 0 1-14 0v-1m7 8v3m-4 0h8"/></svg></span>
                <strong>대화를 시작해 보세요</strong>
                <p>시작 버튼을 누른 뒤 말씀하시면 대화 내용이 여기에 표시됩니다.</p>
              </div>}
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
            <div className="poc-control-card">
              <div className="poc-status-row">
                <span className={`poc-status-dot voice-phase-${state.phase}`} aria-hidden="true" />
                <div><span className="poc-status-label">대화 상태</span><p className="poc-status-value" role="status">{voiceConfigured ? STATUS[state.phase] : "음성 대화를 사용할 수 없어요"}</p></div>
              </div>
              {!voiceConfigured ? <p className="poc-status-hint">음성 서비스를 사용할 수 있도록 설정을 확인해 주세요.</p>
                : <p className="poc-status-hint">{statusHint(state.phase)}</p>}
              {error && <div className="answer-bubble error-bubble mt-3" role="alert"><strong>{error.title}</strong><p>{error.message}</p></div>}
              <div className="poc-actions">
                <button type="button" className="primary-button poc-start-button" disabled={!voiceConfigured || !canStart || confirmReset} onClick={() => void start()}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Z"/><path d="M19 11v1a7 7 0 0 1-14 0v-1m7 8v3m-4 0h8"/></svg>{state.phase === "error" ? "다시 연결" : "대화 시작"}</button>
                <button type="button" className="outline-button poc-stop-button" disabled={canStart || state.phase === "ending"} onClick={() => void endConversation()}>대화 종료</button>
              </div>
            </div>
            {confirmReset && <section className="mt-4 rounded-lg border border-[var(--line)] p-4" aria-labelledby="reset-dialogue-title">
              <h2 id="reset-dialogue-title" className="font-bold text-[var(--navy)]">대화가 끝났어요. 기록을 초기화할까요?</h2>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="outline-button" onClick={() => setConfirmReset(false)}>기록 유지</button>
                <button type="button" className="primary-button" onClick={onReset}>초기화</button>
              </div>
            </section>}
          </section>
        </div>
      </section>
    </main>
  );
}
