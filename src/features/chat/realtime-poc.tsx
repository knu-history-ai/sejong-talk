"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { TurnResponse } from "@/contracts";
import { requestSampleTurn } from "./sample-turn";

type SampleTurn = {
  id: string;
  question: string;
  response: TurnResponse | null;
};

const sampleQuestion = "훈민정음은 왜 만드셨나요?";

const sampleEvents = {
  idle: { status: "대기 중", message: "대화 시작을 눌러 음성 대화를 시험해 보세요." },
  listening: { status: "듣는 중", message: "샘플 질문 보내기를 눌러 음성 인식 결과를 확인해 보세요." },
  speaking: { status: "답변 중", message: "세종대왕이 답변하고 있어요." },
  micDenied: {
    status: "오류",
    title: "마이크를 사용할 수 없어요",
    message: "브라우저의 사이트 설정에서 마이크를 허용한 뒤 대화를 다시 시작해 주세요.",
  },
  disconnected: {
    status: "오류",
    title: "음성 대화 연결이 끊겼어요",
    message: "네트워크 연결을 확인한 뒤 대화를 다시 시작해 주세요.",
  },
} as const;

export function RealtimePoc() {
  const [event, setEvent] = useState<keyof typeof sampleEvents>("idle");
  const [turns, setTurns] = useState<SampleTurn[]>([]);
  const [confirmReset, setConfirmReset] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const dialogue = useRef<HTMLDivElement>(null);
  const waiting = turns.at(-1)?.response === null;
  const current = waiting
    ? { status: "답변 준비 중", message: "세종대왕의 답변을 기다리고 있어요." }
    : sampleEvents[event];
  const hasError = "title" in current;
  const active = event === "listening" || event === "speaking";

  useEffect(() => () => pending.current?.abort(), []);

  useEffect(() => {
    const log = dialogue.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [turns]);

  function startConversation() {
    setEvent("listening");
  }

  function endConversation() {
    pending.current?.abort();
    pending.current = null;
    if (waiting) {
      setTurns((previous) => previous.map((turn) => turn.response === null
        ? { ...turn, response: { requestId: turn.id, operation: "turn", status: "cancelled" } }
        : turn));
    }
    setEvent("idle");
    setConfirmReset(true);
  }

  function resetConversation() {
    setTurns([]);
    setConfirmReset(false);
  }

  async function submitSampleQuestion(fail = false) {
    if (!active || pending.current) return;

    const controller = new AbortController();
    pending.current = controller;
    const id = crypto.randomUUID();
    setEvent("listening");
    setTurns((previous) => [...previous, { id, question: sampleQuestion, response: null }]);

    const response = await requestSampleTurn(
      { requestId: id, text: sampleQuestion },
      { signal: controller.signal, fail },
    );
    if (pending.current !== controller) return;
    pending.current = null;
    setTurns((previous) => previous.map((turn) => turn.id === id ? { ...turn, response } : turn));
  }

  return (
    <main className="sejong-app chat-page">
      <header className="site-header">
        <Link className="brand" href="/">
          <Image src="/images/logo-sejongtalk.png" alt="세종톡 홈" width={1928} height={815} sizes="140px" />
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
                <Image className="chat-icon" src="/images/icon-chat.png" alt="" width={36} height={36} />
                세종대왕과 음성 대화
              </h1>
              <span className="sample-badge">PoC 미리보기</span>
            </div>

            <div className="dialogue min-h-36!" ref={dialogue} aria-label="예시 대화" role="log">
              <div className="message sejong-message">
                <Image className="avatar" src="/images/avatar-sejong.png" alt="" width={48} height={48} />
                <div className="min-w-0">
                  <strong className="speaker-name">세종대왕</strong>
                  <div className="answer-bubble">
                    <p>반갑구나. 무엇이 궁금하니?</p>
                  </div>
                </div>
              </div>
              {turns.map(({ id, question, response }) => (
                <div className="conversation-turn" key={id}>
                  <div className="message student-message">
                    <div>
                      <strong className="speaker-name text-right">나</strong>
                      <p>{question}</p>
                    </div>
                    <Image className="avatar" src="/images/avatar-student.png" alt="" width={48} height={48} />
                  </div>
                  <div className="message sejong-message">
                    <Image className="avatar" src="/images/avatar-sejong.png" alt="" width={48} height={48} />
                    <div className="min-w-0">
                      <strong className="speaker-name">세종대왕</strong>
                      {!response && (
                        <div className="answer-bubble">
                          <p>잠시만 기다려 주겠느냐? 답변을 준비하고 있단다.</p>
                          <span className="typing-dots" aria-hidden="true"><i /><i /><i /></span>
                        </div>
                      )}
                      {response?.status === "approved" && (
                        <div className="answer-bubble"><p>{response.answer.text}</p></div>
                      )}
                      {response?.status === "failed" && (
                        <div className="answer-bubble error-bubble" role="alert">
                          <p>{response.message}</p>
                        </div>
                      )}
                      {response?.status === "cancelled" && (
                        <div className="answer-bubble cancelled-bubble">
                          <p>대화가 종료되어 답변 준비를 멈췄어요.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {confirmReset ? (
              <section className="mt-6 rounded-lg border border-[var(--line)] p-4" aria-labelledby="reset-poc-title">
                <h2 id="reset-poc-title" className="font-bold text-[var(--navy)]">대화가 끝났어요. 기록을 초기화할까요?</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">아니요를 선택하면 지금까지의 대화를 계속 볼 수 있어요.</p>
                <div className="mt-4 flex flex-wrap gap-2">
                  <button type="button" className="primary-button" onClick={() => setConfirmReset(false)}>아니요</button>
                  <button type="button" className="outline-button" onClick={resetConversation}>초기화</button>
                </div>
              </section>
            ) : <div className="mt-6 rounded-lg border border-[var(--line)] p-4">
              <p className="font-bold text-[var(--navy)]" role="status">{current.status}</p>
              {hasError ? (
                <div className="answer-bubble error-bubble mt-3" role="alert">
                  <strong>{current.title}</strong>
                  <p>{current.message}</p>
                </div>
              ) : (
                <p className="mt-1 text-sm text-[var(--muted)]">{current.message}</p>
              )}
              <div className="mt-4 flex flex-wrap gap-2">
                <button type="button" className="primary-button" disabled={active || waiting} onClick={startConversation}>대화 시작</button>
                {active && (
                  <button type="button" className="primary-button" disabled={waiting} onClick={() => void submitSampleQuestion()}>샘플 질문 보내기</button>
                )}
                <button type="button" className="outline-button" disabled={event === "idle"} onClick={endConversation}>대화 종료</button>
              </div>
            </div>}

            <details className="mt-5 border-t border-[var(--line)] pt-4">
              <summary className="w-fit cursor-pointer text-sm font-bold text-[var(--navy)]">샘플 이벤트</summary>
              <div className="mt-3 flex flex-wrap gap-2">
                <button type="button" className="outline-button" disabled={!active || waiting} onClick={startConversation}>듣기 시작</button>
                <button type="button" className="outline-button" disabled={!active || waiting} onClick={() => setEvent("speaking")}>답변 시작</button>
                <button type="button" className="outline-button" disabled={waiting || confirmReset} onClick={() => setEvent("micDenied")}>마이크 권한 거부</button>
                <button type="button" className="outline-button" disabled={!active || waiting} onClick={() => setEvent("disconnected")}>연결 끊김</button>
                <button type="button" className="outline-button" disabled={!active || waiting} onClick={() => void submitSampleQuestion(true)}>응답 실패</button>
              </div>
            </details>
          </section>
        </div>
      </section>
    </main>
  );
}
