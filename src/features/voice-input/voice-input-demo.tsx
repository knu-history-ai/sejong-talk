"use client";

import { useState } from "react";
import { VoiceInput } from "./voice-input";

export function VoiceInputDemo() {
  const [confirmed, setConfirmed] = useState("");
  const [count, setCount] = useState(0);
  const [session, setSession] = useState(0);
  return <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
    <h1 className="text-3xl font-bold">음성 질문 시험실</h1>
    <p>W01-04 · W02-04 녹음 → 예시 글 확인·수정 → 수동 전송 시험. AI 및 STT API를 호출하지 않습니다.</p>
    <VoiceInput key={session} onConfirm={async (text) => { setConfirmed(text); setCount((value) => value + 1); }} />
    <section className="space-y-2 rounded-xl border border-slate-300 p-4" aria-label="전송 확인">
      <h2 className="font-semibold">화면 연결 확인: {count}회 전달</h2>
      <p className="whitespace-pre-wrap break-words">{confirmed || "아직 전송한 질문이 없습니다."}</p>
      <p className="text-sm">이 영역은 확인한 글만 보여 줍니다. 실제 AI 답변이 아닙니다.</p>
    </section>
    <button type="button" className="rounded-lg border border-slate-400 px-4 py-3" onClick={() => { setSession((value) => value + 1); setConfirmed(""); setCount(0); }}>시험 초기화</button>
  </main>;
}
