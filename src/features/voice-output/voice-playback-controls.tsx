"use client";

import type { PlaybackStatus } from "./playback-controller";

type Props = {
  status: PlaybackStatus;
  speed: number;
  onPlay: () => void;
  onStop: () => void;
  onReplay: () => void;
  onSpeedChange: (speed: number) => void;
};

const messages: Record<PlaybackStatus, string> = {
  idle: "답변 듣기를 눌러 주세요.",
  loading: "음성을 준비하고 있어요.",
  playing: "답변 음성을 재생하고 있어요.",
  paused: "재생이 정지되었거나 끝났어요. 다시 들을 수 있어요.",
  error: "음성을 재생하지 못했어요. 답변 듣기를 다시 눌러 주세요.",
};

// The parent owns one playback hook and connects its actions to these controls.
export function VoicePlaybackControls({
  status, speed, onPlay, onStop, onReplay, onSpeedChange,
}: Props) {
  const busy = status === "loading" || status === "playing";
  const button = "rounded-lg border border-slate-400 px-4 py-3 font-medium disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-700";

  return (
    <section className="space-y-4 rounded-xl border border-slate-300 p-4" aria-label="답변 음성 재생">
      <p role={status === "error" ? "alert" : "status"}>{messages[status]}</p>
      <div className="flex flex-wrap gap-3">
        <button type="button" className={button} disabled={busy} onClick={onPlay}>답변 듣기</button>
        <button type="button" className={button} disabled={!busy} onClick={onStop}>정지</button>
        <button type="button" className={button} disabled={status !== "paused"} onClick={onReplay}>다시 듣기</button>
      </div>
      <div className="flex flex-wrap items-center gap-3" role="group" aria-label="재생 속도">
        <span>재생 속도</span>
        {[0.8, 1, 1.2].map((value) => (
          <button key={value} type="button" className={button} aria-pressed={speed === value} onClick={() => onSpeedChange(value)}>
            {value.toFixed(1)}배
          </button>
        ))}
      </div>
    </section>
  );
}
