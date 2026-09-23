"use client";

import { useEffect, useRef, useState } from "react";
import { VoiceRecorder, type Snapshot } from "./recorder";
import { mockTranscribe } from "./mock-transcription";

type Props = {
  onConfirm: (text: string) => Promise<void>;
  onBeforeRecording?: () => void; // Parent stops any TTS playback here.
};

/** Mount with key={sessionId} to invalidate work when the conversation resets. */
export function VoiceInput({ onConfirm, onBeforeRecording }: Props) {
  const [state, setState] = useState<Snapshot>({ phase: "idle", elapsedMs: 0, message: "녹음하거나 글로 질문해 보세요." });
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState("");
  const [replace, setReplace] = useState(false);
  const recorder = useRef<VoiceRecorder | null>(null);
  const sendLock = useRef(false);
  const lifecycle = useRef(0);

  useEffect(() => {
    const generation = lifecycle.current;
    const controller = new VoiceRecorder(setState, setText, mockTranscribe);
    recorder.current = controller;
    const leave = () => controller.cancel();
    // Mobile screen lock/background suspension can delay MediaRecorder chunks/timers.
    const visibility = () => { if (document.hidden) controller.cancel(); };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      lifecycle.current = generation + 1;
      controller.dispose();
      recorder.current = null;
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const busy = ["permission", "recording", "stopping", "transcribing"].includes(state.phase);
  const start = () => {
    setReplace(false);
    setSendMessage("");
    onBeforeRecording?.();
    void recorder.current?.start();
  };
  const submit = async () => {
    if (sendLock.current || busy || !text.trim() || text.length > 500) return;
    const generation = lifecycle.current;
    sendLock.current = true;
    setSending(true);
    setSendMessage("");
    try {
      await onConfirm(text.trim());
      if (generation === lifecycle.current) { setText(""); setSendMessage("확인한 질문을 전달했어요."); }
    } catch {
      if (generation === lifecycle.current) setSendMessage("질문을 전달하지 못했어요. 입력한 글은 유지했으니 다시 시도해 주세요.");
    } finally {
      if (generation === lifecycle.current) { sendLock.current = false; setSending(false); }
    }
  };
  const button = "rounded-lg border border-slate-400 px-4 py-3 font-medium disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700";

  return (
    <section className="space-y-5 rounded-2xl border border-slate-300 bg-white p-5 text-slate-900" aria-label="음성 입력 시험">
      <p className="rounded-lg bg-amber-50 p-3 text-sm">개발용 예시 모드 · 녹음은 이 브라우저에서만 처리해요. 실제 인식 대신 고정된 예시 문장을 보여 줘요.</p>
      <p role="status" aria-live="polite">{state.message}</p>
      <p className="font-mono" aria-label="녹음 경과 시간">{(state.elapsedMs / 1000).toFixed(1)} / 30.0초 · 최대 5 MB</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className={button} disabled={busy || sending || replace} onClick={() => text.trim() ? setReplace(true) : start()}>녹음 시작</button>
        <button type="button" className={button} disabled={state.phase !== "recording"} onClick={() => recorder.current?.stop()}>녹음 종료</button>
        <button type="button" className={button} disabled={!busy} onClick={() => recorder.current?.cancel()}>녹음·인식 취소</button>
      </div>
      {replace && <div className="space-y-3 rounded-lg bg-slate-100 p-4">
        <p>새 녹음이 성공하면 현재 입력한 글을 예시 인식문으로 바꿀까요? 취소하거나 실패하면 현재 글을 유지해요.</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className={button} onClick={start}>바꾸고 녹음</button>
          <button type="button" className={button} onClick={() => setReplace(false)}>현재 글 유지</button>
        </div>
      </div>}
      <div>
        <label htmlFor="voice-question" className="mb-2 block font-semibold">질문 확인·수정</label>
        <textarea id="voice-question" className="min-h-32 w-full rounded-lg border border-slate-400 p-3 disabled:bg-slate-100" value={text} disabled={busy || sending} onChange={(event) => setText(event.target.value)} aria-describedby="question-limit" placeholder="마이크 없이도 여기에 질문을 입력할 수 있어요." />
        <p id="question-limit" className={text.length > 500 ? "text-red-700" : "text-slate-600"}>{text.length} / 500자{ text.length > 500 ? " · 질문을 줄여 주세요." : ""}</p>
      </div>
      <button type="button" className={`${button} bg-blue-800 text-white`} disabled={busy || sending || replace || !text.trim() || text.length > 500} onClick={() => void submit()}>{sending ? "전달 중…" : "확인한 질문 전송"}</button>
      <p role="status">{sendMessage}</p>
      {state.bytes !== undefined && <p className="break-all text-sm text-slate-600">녹음 메타데이터: {state.mimeType} · {state.bytes.toLocaleString()} bytes (원본 저장 안 함)</p>}
      {state.code && <p className="text-sm text-slate-600">시험용 오류 코드: {state.code}</p>}
    </section>
  );
}
