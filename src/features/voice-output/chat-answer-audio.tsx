"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { fetchApprovedSpeech, SpeechPlaybackError } from "./speech-client";
import { useVoicePlayback } from "./use-voice-playback";

type Props = {
  /** Approved answer ID from the turn response. The server synthesizes only stored approved text. */
  answerId: string;
  speed: number;
  /** "자동 듣기": start once when this answer first appears. */
  autoPlay?: boolean;
  disabled?: boolean;
  /** Cancel downloads and release audio before a session change or microphone opens. */
  cancelRef?: Ref<() => void>;
  onSessionExpired?: () => void;
  icon?: ReactNode;
};

/** Chat-styled wrapper around the W03-05 approved-answer playback. Mount with key={answerId}. */
export function ChatAnswerAudio({ answerId, speed, autoPlay = false, disabled = false, cancelRef, onSessionExpired, icon }: Props) {
  const { status, play, stop: stopPlayback, replay, setSpeed, reset } = useVoicePlayback();
  const pending = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);
  const expiredRef = useRef(onSessionExpired);
  useEffect(() => { expiredRef.current = onSessionExpired; });

  useEffect(() => { setSpeed(speed); }, [speed, setSpeed]);
  useEffect(() => () => {
    const controller = pending.current;
    pending.current = null;
    controller?.abort();
    // StrictMode cleans up and re-runs effects on the same mounted answer.
    autoStarted.current = false;
  }, []);

  const listen = useCallback(async () => {
    if (disabled || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    reset();
    setError(null);
    setLoading(true);
    controller.signal.addEventListener("abort", () => {
      if (pending.current === controller) setLoading(false);
    }, { once: true });
    try {
      const blob = await fetchApprovedSpeech({ requestId: crypto.randomUUID(), answerId }, controller.signal);
      if (pending.current !== controller || controller.signal.aborted) return;
      setLoading(false);
      await play(blob);
    } catch (cause) {
      if (pending.current !== controller || controller.signal.aborted) return;
      if (cause instanceof SpeechPlaybackError && cause.code === "SESSION_EXPIRED") expiredRef.current?.();
      setError(cause instanceof SpeechPlaybackError ? cause.message : "음성을 재생하지 못했어요. 다시 눌러 주세요.");
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }, [answerId, disabled, play, reset]);

  const stop = useCallback((release = false) => {
    pending.current?.abort();
    pending.current = null;
    autoStarted.current = true;
    if (release) reset();
    else stopPlayback();
  }, [reset, stopPlayback]);

  useImperativeHandle(cancelRef, () => () => stop(true), [stop]);
  useEffect(() => { if (disabled) stop(true); }, [disabled, stop]);

  useEffect(() => {
    if (!autoPlay || disabled || autoStarted.current) return;
    autoStarted.current = true;
    void listen();
  }, [autoPlay, disabled, listen]);

  const preparing = loading || status === "loading";
  const busy = preparing || status === "playing";
  const label = preparing ? "음성 준비 중" : status === "playing" ? "듣기 멈추기" : status === "paused" ? "다시 듣기" : "답변 듣기";
  const message = error ?? (status === "error" ? "음성을 재생하지 못했어요. 답변 듣기를 다시 눌러 주세요." : null);
  return <>
    <button type="button" className="primary-button listen-button" disabled={disabled} aria-pressed={status === "playing"}
      onClick={() => { if (disabled) return; if (busy) stop(); else if (status === "paused") void replay(); else void listen(); }}>
      {icon}{label}
    </button>
    {message && <p className="voice-status" role="alert">{message}</p>}
  </>;
}
