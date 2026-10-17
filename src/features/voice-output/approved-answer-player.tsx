"use client";

import { useEffect, useRef, useState } from "react";
import { fetchApprovedSpeech, SpeechPlaybackError } from "./speech-client";
import { useVoicePlayback } from "./use-voice-playback";
import { VoicePlaybackControls } from "./voice-playback-controls";

// Mount with key={`${sessionId}:${answerId}`}; replacing the answer cancels old downloads.
export function ApprovedAnswerPlayer({ answerId }: { answerId: string }) {
  const playback = useVoicePlayback();
  const pending = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);

  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  async function listen() {
    if (pending.current || expired) return;
    const controller = new AbortController();
    pending.current = controller;
    playback.reset();
    setError(null);
    setLoading(true);
    try {
      const blob = await fetchApprovedSpeech({ requestId: crypto.randomUUID(), answerId }, controller.signal);
      if (pending.current !== controller || controller.signal.aborted) return;
      setLoading(false);
      await playback.play(blob);
    } catch (cause) {
      if (pending.current !== controller || controller.signal.aborted) return;
      setError(cause instanceof SpeechPlaybackError ? cause.message : "음성을 가져오지 못했습니다. 다시 시도해 주세요.");
      setExpired(cause instanceof SpeechPlaybackError && cause.code === "SESSION_EXPIRED");
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setLoading(false);
      }
    }
  }

  function stop() {
    pending.current?.abort();
    pending.current = null;
    setLoading(false);
    playback.stop();
  }

  return (
    <div className="space-y-3">
      {error && <p role="alert">{error}</p>}
      {expired && <p>시험 대화를 새로 시작해 주세요.</p>}
      <fieldset disabled={expired}>
        <VoicePlaybackControls
          status={loading ? "loading" : error ? "error" : playback.status}
          speed={playback.speed}
          onPlay={() => void listen()}
          onStop={stop}
          onReplay={() => void playback.replay()}
          onSpeedChange={playback.setSpeed}
        />
      </fieldset>
    </div>
  );
}
