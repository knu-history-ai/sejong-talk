"use client";

import { useEffect, useState } from "react";
import { VoiceInput } from "./voice-input";

export function VoiceInputDemo() {
  const [confirmed, setConfirmed] = useState("");
  const [count, setCount] = useState(0);
  const [session, setSession] = useState(0);
  const [failSend, setFailSend] = useState(false);
  const [sessionMessage, setSessionMessage] = useState("대화 세션을 준비하고 있어요.");
  // /api/transcriptions requires a session cookie like the chat screen (W03-04).
  useEffect(() => {
    let active = true;
    void fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: "sejong" }) })
      .then((response) => { if (active) setSessionMessage(response.ok ? "시험용 대화 세션이 준비됐어요." : "세션을 만들지 못했어요. 휴대폰 터널 주소라면 APP_ORIGIN을 확인해 주세요."); })
      .catch(() => { if (active) setSessionMessage("세션을 만들지 못했어요. 개발 서버를 확인해 주세요."); });
    return () => { active = false; };
  }, [session]);
  return <main className="mx-auto max-w-2xl space-y-6 px-4 py-10">
    <h1 className="text-3xl font-bold">음성 질문 시험실</h1>
    <p>W02-04 · W03-04 녹음 → 세션 확인 → 실제 STT → 글 확인·수정 → 수동 전송 시험. AI 서버는 아직 연결되지 않았습니다.</p>
    <p role="status" className="text-sm text-slate-600">{sessionMessage}</p>
    <a href="/dev/stt-test" className="text-blue-800 underline">5개 STT 비교 화면</a>
    <label className="block"><input type="checkbox" checked={failSend} onChange={(event) => setFailSend(event.target.checked)} /> 전송 실패 시험</label>
    <VoiceInput key={session} onConfirm={async (text) => { if (failSend) throw new Error("전송 실패 시험"); setConfirmed(text); setCount((value) => value + 1); }} />
    <section className="space-y-2 rounded-xl border border-slate-300 p-4" aria-label="전송 확인">
      <h2 className="font-semibold">화면 연결 확인: {count}회 전달</h2>
      <p className="whitespace-pre-wrap break-words">{confirmed || "아직 전송한 질문이 없습니다."}</p>
      <p className="text-sm">이 영역은 확인한 글만 보여 줍니다. 실제 AI 답변이 아닙니다.</p>
    </section>
    <button type="button" className="rounded-lg border border-slate-400 px-4 py-3" onClick={() => { setSession((value) => value + 1); setConfirmed(""); setCount(0); }}>시험 초기화</button>
  </main>;
}
