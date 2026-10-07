"use client";

import { useState } from "react";
import { createPlaybackFixture } from "../../../tests/fixtures/contracts";
import { useVoicePlayback } from "./use-voice-playback";
import { VoicePlaybackControls } from "./voice-playback-controls";

function SamplePlayer() {
  const playback = useVoicePlayback();
  const [failPlayback, setFailPlayback] = useState(false);

  return (
    <>
      <label className="block">
        <input type="checkbox" checked={failPlayback} onChange={(event) => setFailPlayback(event.target.checked)} /> 재생 오류 시험
      </label>
      <VoicePlaybackControls
        status={playback.status}
        speed={playback.speed}
        onPlay={() => void playback.play(failPlayback ? new Blob([], { type: "audio/wav" }) : createPlaybackFixture())}
        onStop={playback.stop}
        onReplay={() => void playback.replay()}
        onSpeedChange={playback.setSpeed}
      />
    </>
  );
}

export function VoiceOutputDemo() {
  const [session, setSession] = useState(0);

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-10 text-slate-900">
      <h1 className="text-3xl font-bold">답변 음성 재생 시험실</h1>
      <p>샘플 음원으로 듣기·정지·다시 듣기·배속·초기화를 확인합니다.</p>
      <p className="rounded-lg bg-amber-50 p-3 text-sm">샘플은 0.1초 무음 WAV라 소리가 나지 않고 바로 재생이 끝납니다. 실제 Azure 음성과 답변 API는 아직 연결하지 않았습니다.</p>
      <SamplePlayer key={session} />
      <button type="button" className="rounded-lg border border-slate-400 px-4 py-3" onClick={() => setSession((value) => value + 1)}>
        시험 초기화
      </button>
    </main>
  );
}
