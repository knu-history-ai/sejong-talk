"use client";

import { useEffect, useRef, useState } from "react";
import type { Answer } from "../../contracts";
import { createPlaybackFixture } from "../../../tests/fixtures/contracts";
import { ApprovedAnswerPlayer } from "./approved-answer-player";
import { SpeechPlaybackError } from "./speech-client";
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
  const [testSession, setTestSession] = useState<{ sessionId: string; answer: Answer } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => {
    pending.current?.abort();
    pending.current = null;
  }, []);

  async function changeTestSession(start: boolean) {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setTestSession(null);
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(start ? "/api/sessions" : "/api/sessions/current", {
        method: start ? "POST" : "DELETE", credentials: "same-origin", signal: controller.signal,
        ...(start ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ characterId: "sejong" }) } : {}),
      });
      const created = await response.json();
      if (!response.ok) throw new SpeechPlaybackError(created?.message || "시험 대화를 변경하지 못했습니다.");
      if (start) {
        const prepared = await fetch("/api/dev/tts-answer", {
          method: "POST", credentials: "same-origin", signal: controller.signal, cache: "no-store",
        });
        const result = await prepared.json();
        if (!prepared.ok) throw new SpeechPlaybackError(result?.message || "시험 답변을 준비하지 못했습니다.");
        if (result.sessionId !== created.sessionId || !result.answer?.answerId || !result.answer?.text) {
          throw new SpeechPlaybackError("시험 대화가 변경되었습니다. 다시 시작해 주세요.");
        }
        if (pending.current === controller && !controller.signal.aborted) setTestSession(result);
      }
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted) {
        setError(cause instanceof SpeechPlaybackError ? cause.message : "시험 대화를 변경하지 못했습니다. 다시 시도해 주세요.");
      }
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-10 text-slate-900">
      <h1 className="text-3xl font-bold">답변 음성 재생 시험실</h1>
      <p>샘플 재생과 Azure API를 통한 답변 음성 재생을 확인합니다.</p>
      <section className="space-y-4" aria-label="샘플 재생 시험">
        <h2 className="text-xl font-semibold">샘플 재생</h2>
        <p className="rounded-lg bg-amber-50 p-3 text-sm">샘플은 0.1초 무음 WAV라 소리가 나지 않고 바로 재생이 끝납니다.</p>
        <SamplePlayer key={session} />
        <button type="button" className="rounded-lg border border-slate-400 px-4 py-3" onClick={() => setSession((value) => value + 1)}>샘플 초기화</button>
      </section>
      <section className="space-y-4" aria-label="Azure 음성 시험">
        <h2 className="text-xl font-semibold">Azure 답변 음성</h2>
        <p>시험 대화 시작은 현재 브라우저의 대화 세션을 교체합니다. 답변 듣기를 누르면 고정된 인사문의 음성을 요청합니다.</p>
        <div className="flex flex-wrap gap-3">
          <button type="button" className="rounded-lg border border-slate-400 px-4 py-3 disabled:opacity-40" disabled={busy} onClick={() => void changeTestSession(true)}>시험 대화 시작</button>
          <button type="button" className="rounded-lg border border-slate-400 px-4 py-3 disabled:opacity-40" disabled={busy} onClick={() => void changeTestSession(false)}>시험 대화 초기화</button>
        </div>
        {busy && <p role="status">시험 대화를 준비하고 있어요.</p>}
        {error && <p role="alert">{error}</p>}
        {testSession && <>
          <p>{testSession.answer.text}</p>
          <ApprovedAnswerPlayer key={`${testSession.sessionId}:${testSession.answer.answerId}`} answerId={testSession.answer.answerId} />
        </>}
      </section>
    </main>
  );
}
