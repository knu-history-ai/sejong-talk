"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { MAX_RECORDING_MS, VoiceRecorder, type Snapshot } from "./recorder";
import { serverTranscribe } from "./transcription";

type Props = {
  /** Disable while an answer is loading or the session has expired. Disabling cancels work in progress. */
  disabled?: boolean;
  /** Current composer text. When non-empty, the user confirms replacing it before recording. */
  draft: string;
  /** Puts the recognized text into the composer. Never sends it; the user reviews and presses send. */
  onTranscript: (text: string) => void;
  /** Composer should become read-only while recording/transcribing so the transcript cannot clobber typing. */
  onBusyChange?: (busy: boolean) => void;
  /** Called when the server reports SESSION_EXPIRED. */
  onSessionExpired?: () => void;
  /** Stop TTS playback here before the microphone opens. */
  onBeforeRecording?: () => void;
  icon?: ReactNode;
};

const BUSY = ["permission", "recording", "stopping", "transcribing"];

/** Compact chat-composer voice control. Mount with key={sessionId} so a reset invalidates late results. */
export function ChatVoiceButton({ disabled = false, draft, onTranscript, onBusyChange, onSessionExpired, onBeforeRecording, icon }: Props) {
  const [state, setState] = useState<Snapshot>({ phase: "idle", elapsedMs: 0, message: "" });
  const [confirmReplace, setConfirmReplace] = useState(false);
  const recorder = useRef<VoiceRecorder | null>(null);
  const callbacks = useRef({ onTranscript, onSessionExpired });
  useEffect(() => { callbacks.current = { onTranscript, onSessionExpired }; });

  useEffect(() => {
    const controller = new VoiceRecorder((next) => {
      setState(next);
      if (next.phase === "error" && next.code === "SESSION_EXPIRED") callbacks.current.onSessionExpired?.();
    }, (text) => callbacks.current.onTranscript(text), serverTranscribe);
    recorder.current = controller;
    const leave = () => controller.cancel();
    const visibility = () => { if (document.hidden) controller.cancel(); };
    window.addEventListener("pagehide", leave);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      controller.dispose();
      recorder.current = null;
      window.removeEventListener("pagehide", leave);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  const busy = BUSY.includes(state.phase);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  // Session expiry/answer loading: drop the attempt and its late transcript.
  useEffect(() => { if (disabled && recorder.current?.isBusy()) recorder.current.cancel(); }, [disabled]);

  const start = () => {
    setConfirmReplace(false);
    onBeforeRecording?.();
    void recorder.current?.start();
  };
  const press = () => {
    if (disabled) return;
    if (state.phase === "recording") { recorder.current?.stop(); return; }
    if (busy) { recorder.current?.cancel(); return; }
    if (draft.trim()) setConfirmReplace(true); else start();
  };
  const seconds = Math.floor(state.elapsedMs / 1000);
  const label = state.phase === "recording" ? `녹음 종료 ${seconds}초`
    : state.phase === "transcribing" || state.phase === "stopping" ? "인식 취소"
    : state.phase === "permission" ? "마이크 대기 취소" : "말로 질문";
  const status = state.phase === "review" ? !draft.trim() ? "" : "인식된 글을 확인하고 고친 뒤 ‘질문 보내기’를 눌러 주세요."
    : state.phase === "recording" ? `녹음 중이에요. 최대 ${MAX_RECORDING_MS / 1000}초까지 말할 수 있어요.`
    : state.phase === "idle" ? "" : state.message;

  return <>
    <button type="button" className={`outline-button mic-button${busy ? " is-recording" : ""}`} aria-pressed={state.phase === "recording"}
      disabled={disabled || confirmReplace} onClick={press}>{icon}<span>{label}</span></button>
    {(status || confirmReplace) && <div className="voice-status" role="status" aria-live="polite">
      {confirmReplace ? <>
        <p>지금 입력한 글을 새 인식 결과로 바꿀까요? 녹음을 취소하거나 실패하면 지금 글을 유지해요.</p>
        <span className="voice-status-actions">
          <button type="button" className="primary-button" onClick={start}>바꾸고 녹음</button>
          <button type="button" className="outline-button" onClick={() => setConfirmReplace(false)}>지금 글 유지</button>
        </span>
      </> : <p>{status}</p>}
    </div>}
  </>;
}
