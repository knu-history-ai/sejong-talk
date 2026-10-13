"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { fetchApprovedSpeech, SpeechPlaybackError } from "./speech-client";
import { useVoicePlayback } from "./use-voice-playback";

type Props = {
  /** Approved answer ID from the turn response. The server synthesizes only stored approved text. */
  answerId: string;
  speed: number;
  /** "자동 듣기": start once when this answer first appears. */
  autoPlay?: boolean;
  onSessionExpired?: () => void;
  icon?: ReactNode;
};

/** Chat-styled wrapper around the W03-05 approved-answer playback. Mount with key={answerId}. */
export function ChatAnswerAudio({ answerId, speed, autoPlay = false, onSessionExpired, icon }: Props) {
  const playback = useVoicePlayback();
  const pending = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoStarted = useRef(false);
  const expiredRef = useRef(onSessionExpired);
  useEffect(() => { expiredRef.current = onSessionExpired; });

  useEffect(() => { playback.setSpeed(speed); }, [speed, playback.setSpeed]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);

  async function listen() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    playback.reset();
    setError(null);
    setLoading(true);
    try {
      const blob = await fetchApprovedSpeech({ requestId: crypto.randomUUID(), answerId }, controller.signal);
      if (pending.current !== controller || controller.signal.aborted) return;
      setLoading(false);
      playback.setSpeed(speed);
      await playback.play(blob);
    } catch (cause) {
      if (pending.current !== controller || controller.signal.aborted) return;
      if (cause instanceof SpeechPlaybackError && cause.code === "SESSION_EXPIRED") expiredRef.current?.();
      setError(cause instanceof SpeechPlaybackError ? cause.message : "음성을 재생하지 못했어요. 다시 눌러 주세요.");
    } finally {
      if (pending.current === controller) { pending.current = null; setLoading(false); }
    }
  }

  function stop() {
    pending.current?.abort();
    pending.current = null;
    setLoading(false);
    playback.stop();
  }

  useEffect(() => {
    if (!autoPlay || autoStarted.current) return;
    autoStarted.current = true;
    void listen();
  });

  const busy = loading || playback.status === "playing";
  const label = loading ? "음성 준비 중" : playback.status === "playing" ? "듣기 멈추기" : playback.status === "paused" ? "다시 듣기" : "답변 듣기";
  return <>
    <button type="button" className="primary-button listen-button" aria-pressed={playback.status === "playing"}
      onClick={() => { if (busy) stop(); else if (playback.status === "paused") void playback.replay(); else void listen(); }}>
      {icon}{label}
    </button>
    {error && <p className="voice-status" role="alert">{error}</p>}
  </>;
}
