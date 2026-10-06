"use client";
import { useEffect, useRef, useState } from "react";
import { VoiceRecorder, type Snapshot } from "./recorder";
import { audioForm } from "./transcription";
import { normalizeAudio } from "./normalize-audio";
import { evaluate } from "./evaluation";
import { TEST_SENTENCES, type SttResult } from "./stt-types";

type Run = { at: string; reference: string; originalMime: string; originalBytes: number; mime: string; bytes: number; results: (SttResult & { evaluation: ReturnType<typeof evaluate> | null })[] };
const button = "rounded-lg border border-slate-400 px-4 py-2 disabled:opacity-40";
export function SttComparison() {
  const [state, setState] = useState<Snapshot>({ phase: "idle", elapsedMs: 0, message: "녹음하거나 30초 이내 음성 파일을 선택해 주세요." });
  const [reference, setReference] = useState(TEST_SENTENCES[0]);
  const [file, setFile] = useState<File>();
  const [uploading, setUploading] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [error, setError] = useState("");
  const recorder = useRef<VoiceRecorder | null>(null);
  const refText = useRef(reference);
  const generation = useRef(0);
  const upload = useRef<AbortController | null>(null);
  const runReference = useRef(reference);
  const recordingBusy = ["permission", "recording", "stopping", "transcribing"].includes(state.phase);
  const busy = recordingBusy || uploading;

  const compare = async (blob: Blob, signal: AbortSignal, expected: string, durationMs?: number) => {
    const token = generation.current;
    const wav = await normalizeAudio(blob, signal, durationMs);
    signal.throwIfAborted();
    const response = await fetch("/api/dev/stt-compare", { method: "POST", body: audioForm(wav), signal: AbortSignal.any([signal, AbortSignal.timeout(22_000)]) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "비교 요청에 실패했어요.");
    if (token !== generation.current || signal.aborted) return;
    const run: Run = { at: new Date().toISOString(), reference: expected, originalMime: blob.type || "확인 불가", originalBytes: blob.size, mime: wav.type, bytes: wav.size, results: data.results.map((result: SttResult) => ({ ...result, evaluation: result.success ? evaluate(expected, result.text) : null })) };
    setRuns((previous) => [run, ...previous].slice(0, 50));
  };

  useEffect(() => {
    const controller = new VoiceRecorder(setState, () => {}, async (recording, signal) => {
      await compare(recording.blob, signal, runReference.current, recording.durationMs);
      return "비교 완료";
    });
    recorder.current = controller;
    const invalidate = () => { ++generation.current; upload.current?.abort(); upload.current = null; };
    const cancel = () => { invalidate(); setUploading(false); controller.cancel(); };
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener("pagehide", cancel);
    document.addEventListener("visibilitychange", hidden);
    return () => { invalidate(); controller.dispose(); window.removeEventListener("pagehide", cancel); document.removeEventListener("visibilitychange", hidden); };
  }, []);

  const cancel = () => { ++generation.current; upload.current?.abort(); upload.current = null; setUploading(false); recorder.current?.cancel(); };
  const uploadFile = async () => {
    if (!file || upload.current || recorder.current?.isBusy()) return;
    const abort = new AbortController(); upload.current = abort;
    const expected = refText.current;
    setUploading(true); setError("");
    try {
      await compare(file, abort.signal, expected);
    } catch (reason) {
      if (!abort.signal.aborted) setError(reason instanceof Error && reason.name !== "EncodingError" ? reason.message : "파일이 손상되었거나 이 브라우저에서 읽을 수 없는 형식이에요.");
    } finally {
      if (upload.current === abort) { upload.current = null; setUploading(false); }
    }
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(runs, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "stt-comparison.json"; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const percentage = (value: number | null | undefined) => value == null ? "—" : `${(value * 100).toFixed(1)}%`;
  return <main className="mx-auto max-w-6xl space-y-6 p-6 text-slate-900">
    <h1 className="text-3xl font-bold">한국어 STT 비교 시험실</h1>
    <p>선정 공급자: Azure Speech Free(F0) · 모든 비교 음원은 WAV / PCM16 / 16kHz / mono로 변환합니다.</p>
    <p>녹음 종료 또는 비교 버튼을 누르면 같은 음원을 5개 공급자에 전송합니다. API 사용료가 발생할 수 있습니다. 결과는 현재 화면에서 최대 50회까지 유지하며 원본 음성을 서버 파일로 저장하지 않습니다.</p>
    <a className="text-blue-800 underline" href="/voice-input-test">선택한 STT로 문장 확인·수정·전송 시험</a>
    <label className="block">테스트 문장<select className="mt-2 block w-full rounded border p-2" disabled={busy} value={TEST_SENTENCES.includes(reference) ? reference : ""} onChange={(e) => { setReference(e.target.value); refText.current = e.target.value; }}>
      <option value="">직접 입력</option>{TEST_SENTENCES.map((sentence) => <option key={sentence}>{sentence}</option>)}
    </select></label>
    <label className="block">예상 정답<textarea className="mt-2 block w-full rounded border p-3" maxLength={1000} disabled={busy} value={reference} onChange={(e) => { setReference(e.target.value); refText.current = e.target.value; }} /></label>
    <p role="status">{uploading || state.phase === "transcribing" ? "같은 음성을 5개 서비스에서 글로 바꾸는 중이에요." : state.phase === "review" ? "비교가 끝났어요. 아래 결과를 확인해 주세요." : state.message}</p>
    <p>{(state.elapsedMs / 1000).toFixed(1)} / 30초 · 최대 5 MB</p>
    <div className="flex flex-wrap gap-3">
      <button className={button} disabled={busy} onClick={() => { if (upload.current) return; setError(""); runReference.current = refText.current; void recorder.current?.start(); }}>녹음 시작</button>
      <button className={button} disabled={state.phase !== "recording"} onClick={() => recorder.current?.stop()}>녹음 종료 후 비교</button>
      <button className={button} disabled={!busy} onClick={cancel}>취소</button>
    </div>
    <div className="flex flex-wrap items-center gap-3">
      <label>기존 음성 파일 <input type="file" accept="audio/*,.webm,.m4a" disabled={busy} onChange={(e) => setFile(e.target.files?.[0])} /></label>
      <button className={button} disabled={busy || !file} onClick={() => void uploadFile()}>파일로 5개 STT 비교</button>
    </div>
    {error && <p role="alert" className="text-red-700">{error}</p>}
    <p className="text-sm">CER은 낮을수록 좋으며 삽입 오류가 많으면 100%를 넘을 수 있습니다. 원문 CER은 공백·문장부호를 포함하고 보조 CER은 공백만 제외합니다. 용어 점수는 정답에 등장한 용어의 포함 여부이며 중첩 용어도 각각 셉니다. 실패한 결과는 점수를 계산하지 않습니다.</p>
    <div className="flex gap-3"><button className={button} disabled={!runs.length} onClick={download}>결과 JSON 내려받기</button><button className={button} onClick={() => { cancel(); setRuns([]); setError(""); setFile(undefined); }}>시험 초기화</button></div>
    {runs.map((run, index) => <section key={`${run.at}-${index}`} className="space-y-2 rounded-xl border p-4">
      <h2 className="font-bold">{run.reference || "정답 없음"}</h2><p className="text-sm">{run.at} · 원본 {run.originalMime} / {run.originalBytes} bytes → 전송 {run.mime} / PCM16 / 16kHz / mono / {run.bytes} bytes</p>
      <p className="text-sm sm:hidden">표를 좌우로 밀면 점수와 처리 시간을 볼 수 있어요.</p>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{["공급자", "인식 결과 / 오류", "처리 시간", "상태", "완전 일치", "원문 CER", "공백 제외 CER", "역사 용어"].map((heading) => <th className="p-2" key={heading}>{heading}</th>)}</tr></thead>
        <tbody>{run.results.map((result) => <tr className="border-t align-top" key={result.provider}>
          <td className="p-2">{result.provider}</td><td className="min-w-48 p-2 whitespace-pre-wrap">{result.success ? result.text : result.error}</td><td className="p-2">{result.latencyMs} ms</td><td className="p-2">{result.success ? "성공" : "실패"}</td>
          <td className="p-2">{result.evaluation?.exactMatch == null ? "—" : result.evaluation.exactMatch ? "일치" : "불일치"}</td><td className="p-2">{percentage(result.evaluation?.cer)}</td><td className="p-2">{percentage(result.evaluation?.cerWithoutSpaces)}</td><td className="p-2">{percentage(result.evaluation?.termAccuracy)}<br />{result.evaluation?.terms.map((term) => `${term.term} ${term.recognized ? "✓" : "✗"}`).join(", ")}</td>
        </tr>)}</tbody></table></div>
    </section>)}
  </main>;
}
