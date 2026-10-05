// Feature-local draft contract. Align with W01-08 before connecting the server.
export const MAX_RECORDING_MS = 30_000;
export const MAX_AUDIO_BYTES = 5_000_000; // Decimal MB, not MiB.
export const MIME_TYPES = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"] as const;
export type Phase = "idle" | "permission" | "recording" | "stopping" | "transcribing" | "review" | "error";
export type Recording = { blob: Blob; mimeType: string; durationMs: number };
export type RecordingDebug = Record<string, string | boolean>;
export type Snapshot = { debug?: RecordingDebug; phase: Phase; elapsedMs: number; message: string; code?: string; mimeType?: string; bytes?: number };
export type Transcribe = (recording: Recording, signal: AbortSignal) => Promise<string>;

export function chooseMimeType(supports: (type: string) => boolean): string | undefined {
  return MIME_TYPES.find(supports);
}

export function rms(samples: Float32Array): number {
  if (!samples.length) return 0;
  return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
}

export function microphoneError(error: unknown): { code: string; message: string } {
  const value = error && typeof error === "object" ? (error as { name?: unknown }).name : "";
  const name = typeof value === "string" ? value : "";
  if (name === "NotAllowedError") return { code: "PERMISSION_DENIED", message: "마이크 권한이 허용되지 않았어요. 브라우저 설정을 확인하거나 글로 질문해 주세요." };
  if (name === "SecurityError") return { code: "MICROPHONE_BLOCKED", message: "이 페이지에서는 마이크 사용이 차단되어 있어요. HTTPS 주소인지 확인하거나 글로 질문해 주세요." };
  if (name === "NotFoundError") return { code: "NO_MICROPHONE", message: "마이크를 찾을 수 없어요. 연결을 확인하거나 글로 질문해 주세요." };
  if (name === "NotReadableError") return { code: "MICROPHONE_BUSY", message: "마이크를 사용할 수 없어요. 다른 앱의 사용 여부를 확인해 주세요." };
  if (name === "AbortError") return { code: "MICROPHONE_ABORTED", message: "마이크 준비가 중단되었어요. 다시 시도하거나 글로 질문해 주세요." };
  if (name === "InvalidStateError") return { code: "RECORDER_INVALID_STATE", message: "녹음을 시작할 수 없는 상태예요. 화면을 새로 고친 뒤 다시 시도하거나 글로 질문해 주세요." };
  if (name === "TypeError") return { code: "RECORDING_UNAVAILABLE", message: "이 환경에서는 녹음 기능을 불러오지 못했어요. 글로 질문해 주세요." };
  return { code: "RECORDING_FAILED", message: "녹음을 준비하지 못했어요. 다시 시도하거나 글로 질문해 주세요." };
}

export interface RecorderEnvironment {
  diagnostics?: () => RecordingDebug;
  supported: () => boolean;
  supportsMime: (mime: string) => boolean;
  getStream: () => Promise<MediaStream>;
  createRecorder: (stream: MediaStream, mime: string) => MediaRecorder;
  createContext: () => AudioContext;
  now: () => number;
}

function audioContextConstructor() {
  return window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

export function browserDiagnostics(): RecordingDebug {
  const result: RecordingDebug = {
    "window.isSecureContext": window.isSecureContext,
    "navigator.mediaDevices": !!navigator.mediaDevices,
    "navigator.mediaDevices.getUserMedia": typeof navigator.mediaDevices?.getUserMedia === "function",
    MediaRecorder: typeof MediaRecorder !== "undefined",
    AudioContext: typeof window.AudioContext !== "undefined",
    webkitAudioContext: typeof (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext !== "undefined",
    "userActivation.isActive": navigator.userActivation?.isActive ?? "unavailable",
  };
  for (const mime of MIME_TYPES) {
    try { result[`isTypeSupported(${mime})`] = typeof MediaRecorder !== "undefined" && typeof MediaRecorder.isTypeSupported === "function" ? MediaRecorder.isTypeSupported(mime) : "unavailable"; }
    catch { result[`isTypeSupported(${mime})`] = "probe threw"; }
  }
  return result;
}

// Only local recording exceptions enter this panel: never STT responses, config,
// request headers, device labels, audio, transcripts or environment variables.
function debugError(error: unknown): RecordingDebug {
  const value = error && typeof error === "object" ? error as { name?: unknown; message?: unknown } : {};
  const redact = (text: unknown) => typeof text === "string" ? text
    .replace(/https?:\/\/\S+/gi, "[URL redacted]")
    .replace(/((?:api[-_ ]?key|token|secret|authorization)\s*[:=]\s*)\S+/gi, "$1[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 500) : "";
  return { "error.name": redact(value.name) || "UnknownError", "error.message": redact(value.message) };
}

const browserEnvironment: RecorderEnvironment = {
  diagnostics: browserDiagnostics,
  supported: () => window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined" && !!audioContextConstructor(),
  supportsMime: (mime) => typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(mime),
  getStream: () => navigator.mediaDevices.getUserMedia({ audio: true }),
  createRecorder: (stream, mimeType) => new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128_000 }),
  createContext: () => { const Context = audioContextConstructor(); if (!Context) throw new Error("AudioContext unavailable"); return new Context(); },
  now: () => performance.now(),
};

/** Owns one attempt. Tokens invalidate permission, recorder and transcription callbacks. */
export class VoiceRecorder {
  private state: Snapshot = { phase: "idle", elapsedMs: 0, message: "녹음하거나 글로 질문해 보세요." };
  private token = 0;
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private analyser?: AnalyserNode;
  private interval?: ReturnType<typeof setInterval>;
  private deadline?: ReturnType<typeof setTimeout>;
  private stopDeadline?: ReturnType<typeof setTimeout>;
  private transcriptionDeadline?: ReturnType<typeof setTimeout>;
  private abort?: AbortController;
  private chunks: Blob[] = [];
  private bytes = 0;
  private startedAt = 0;
  private audibleFrames = 0;
  private disposed = false;

  constructor(
    private readonly onChange: (state: Snapshot) => void,
    private readonly onTranscript: (text: string) => void,
    private readonly transcribe: Transcribe,
    private readonly env: RecorderEnvironment = browserEnvironment,
  ) {}

  isBusy() { return ["permission", "recording", "stopping", "transcribing"].includes(this.state.phase); }

  private update(next: Partial<Snapshot>) {
    this.state = { ...this.state, ...next };
    if (!this.disposed) this.onChange(this.state);
  }

  private debug(next: RecordingDebug) {
    if (process.env.NODE_ENV === "development") this.update({ debug: { ...this.state.debug, ...next } });
  }

  /** Development panel only: capability flags before the first click. */
  probe() {
    try { this.debug(this.env.diagnostics?.() ?? {}); }
    catch (error) { this.debug({ ...debugError(error), errorStage: "capability probe" }); }
  }

  private releaseMicrophone() {
    clearInterval(this.interval);
    clearTimeout(this.deadline);
    const tracks = this.stream?.getTracks() ?? [];
    tracks.forEach((track) => { track.onended = null; track.stop(); });
    if (tracks.length) this.debug({ "streamTrack.readyState": tracks.map((track) => track.readyState).join(", "), microphoneReleased: true });
    this.stream = undefined;
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.source = undefined;
    this.analyser = undefined;
    if (this.context && this.context.state !== "closed") void this.context.close().catch(() => {});
    this.context = undefined;
  }

  private cleanup() {
    this.abort?.abort();
    this.abort = undefined;
    clearTimeout(this.stopDeadline);
    clearTimeout(this.transcriptionDeadline);
    if (this.recorder) {
      this.recorder.ondataavailable = null;
      this.recorder.onstop = null;
      this.recorder.onerror = null;
      try { if (this.recorder.state !== "inactive") this.recorder.stop(); } catch { /* Still release tracks. */ }
    }
    this.recorder = undefined;
    this.releaseMicrophone();
    this.chunks = [];
    this.bytes = 0;
  }

  private fail(code: string, message: string) {
    ++this.token;
    this.cleanup();
    this.update({ phase: "error", code, message });
  }

  async start() {
    if (this.disposed || ["permission", "recording", "stopping", "transcribing"].includes(this.state.phase)) return;
    this.cleanup();
    const token = ++this.token;
    this.audibleFrames = 0;
    this.update({ phase: "permission", elapsedMs: 0, code: undefined, bytes: undefined, mimeType: undefined, message: "마이크 사용을 허용해 주세요. 기다리는 중에도 취소할 수 있어요." });
    this.update({ debug: undefined });
    this.debug({ stage: "capability check", selectedMime: "not selected", actualMime: "not created", getUserMediaRequested: false, getUserMediaSucceeded: false, mediaRecorderCreated: false, mediaRecorderStarted: false, audioContextResume: "not requested", streamTrackCount: "no stream", dataavailableCount: "0", "blob.type": "no blob", "blob.size": "no blob", durationMs: "not finished", errorStage: "", "error.name": "", "error.message": "" });
    try {
      if (process.env.NODE_ENV === "development") this.debug(this.env.diagnostics?.() ?? {});
      if (!this.env.supported()) {
        this.fail("UNSUPPORTED_BROWSER", "이 환경에서는 녹음을 사용할 수 없어요. HTTPS 또는 localhost에서 지원 브라우저를 사용하거나 글로 질문해 주세요.");
        return;
      }
      this.debug({ stage: "MIME negotiation" });
      const mimeType = chooseMimeType(this.env.supportsMime);
      if (!mimeType) { this.fail("AUDIO_UNSUPPORTED", "지원하는 녹음 형식이 없어요. 다른 브라우저 또는 글 입력을 이용해 주세요."); return; }
      this.debug({ selectedMime: mimeType, stage: "AudioContext creation" });
      // Start/resume AudioContext inside the user's click, before awaiting permission (Safari).
      const context = this.env.createContext();
      this.context = context;
      this.debug({ stage: "AudioContext.resume()", audioContextResume: "requested" });
      const resumed = context.resume().then(() => {
        if (token === this.token) this.debug({ audioContextResume: "resolved", audioContextState: context.state });
        return true;
      }, (error: unknown) => {
        if (token === this.token) this.debug({ audioContextResume: "rejected", ...debugError(error), errorStage: "AudioContext.resume()" });
        return false;
      });
      this.debug({ stage: "getUserMedia", getUserMediaRequested: true });
      const stream = await this.env.getStream();
      if (token !== this.token) { stream.getTracks().forEach((track) => track.stop()); return; }
      this.stream = stream;
      const tracks = stream.getTracks();
      // State flags only; never the device label.
      this.debug({ getUserMediaSucceeded: true, stage: "await AudioContext.resume()", streamTrackCount: String(tracks.length), "streamTrack.readyState": tracks.map((track) => track.readyState).join(", "), "streamTrack.enabled": tracks.map((track) => track.enabled).join(", "), "streamTrack.muted": tracks.map((track) => track.muted).join(", "), microphoneReleased: false });
      if (!(await resumed) || context.state !== "running") {
        if (token === this.token) this.fail("AUDIO_ANALYSIS_FAILED", "소리를 확인할 수 없어요. 다시 녹음하거나 글로 질문해 주세요.");
        return;
      }
      if (token !== this.token) return;
      this.debug({ stage: "audio analyser", audioContextState: context.state });
      this.source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      this.analyser = analyser;
      this.source.connect(analyser); // Never connect microphone to speakers.
      const samples = new Float32Array(analyser.fftSize);
      this.debug({ stage: "MediaRecorder constructor" });
      const recorder = this.env.createRecorder(stream, mimeType);
      this.recorder = recorder;
      const actualMime = recorder.mimeType || mimeType;
      this.debug({ mediaRecorderCreated: true, actualMime });
      let dataEvents = 0;
      recorder.ondataavailable = (event) => {
        if (token !== this.token || !event.data.size) return;
        this.bytes += event.data.size;
        this.debug({ dataavailableCount: `${++dataEvents} (${this.bytes} bytes)` });
        if (this.bytes > MAX_AUDIO_BYTES) { this.fail("AUDIO_TOO_LARGE", "녹음이 5 MB를 넘었어요. 더 짧게 녹음해 주세요."); return; }
        this.chunks.push(event.data);
      };
      recorder.onerror = (event) => {
        if (token !== this.token) return;
        const error = (event as Event & { error?: DOMException }).error;
        this.debug({ ...debugError(error), errorStage: "MediaRecorder error event" });
        this.fail("RECORDING_FAILED", "녹음 중 문제가 생겼어요. 다시 녹음하거나 글로 질문해 주세요.");
      };
      recorder.onstop = () => { if (token === this.token) void this.finish(token, actualMime); };
      stream.getTracks().forEach((track) => { track.onended = () => { if (token === this.token) this.fail("MICROPHONE_DISCONNECTED", "마이크 연결이 끊어졌어요. 다시 연결해 주세요."); }; });
      this.debug({ stage: "recorder.start()" });
      recorder.start(250);
      this.debug({ mediaRecorderStarted: true, stage: "recording" });
      this.startedAt = this.env.now();
      this.update({ phase: "recording", mimeType: actualMime, message: "녹음 중이에요. 말을 마치면 종료를 눌러 주세요." });
      this.interval = setInterval(() => {
        if (token !== this.token || this.state.phase !== "recording") return;
        analyser.getFloatTimeDomainData(samples);
        if (rms(samples) >= 0.01) ++this.audibleFrames;
        const elapsedMs = this.env.now() - this.startedAt;
        this.update({ elapsedMs: Math.min(elapsedMs, MAX_RECORDING_MS) });
        if (elapsedMs >= MAX_RECORDING_MS) this.stop();
      }, 50);
      this.deadline = setTimeout(() => this.stop(), MAX_RECORDING_MS);
    } catch (error) {
      if (token === this.token) { this.debug({ ...debugError(error), errorStage: this.state.debug?.stage ?? "start" }); const detail = microphoneError(error); this.fail(detail.code, detail.message); }
    }
  }

  stop() {
    if (this.state.phase !== "recording") return;
    const durationMs = this.env.now() - this.startedAt;
    this.update({ phase: "stopping", elapsedMs: durationMs, message: "녹음을 마무리하고 있어요." });
    try {
      this.recorder?.stop();
      this.releaseMicrophone();
      // Background timer delays must not silently pass an overlength recording.
      if (durationMs > MAX_RECORDING_MS + 250) { this.fail("AUDIO_TOO_LONG", "녹음 시간 제한을 넘었어요. 화면을 켠 상태에서 30초 이내로 다시 녹음해 주세요."); return; }
      this.stopDeadline = setTimeout(() => this.fail("RECORDING_FAILED", "녹음을 마무리하지 못했어요. 다시 녹음해 주세요."), 3000);
    } catch { this.fail("RECORDING_FAILED", "녹음을 종료하지 못했어요. 다시 녹음해 주세요."); }
  }

  private async finish(token: number, mimeType: string) {
    clearTimeout(this.stopDeadline);
    this.releaseMicrophone();
    if (this.state.phase !== "stopping") { this.fail("RECORDING_INTERRUPTED", "녹음이 중단되었어요. 다시 녹음해 주세요."); return; }
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];
    this.recorder = undefined;
    this.debug({ stage: "blob created", "blob.type": blob.type || "(empty)", "blob.size": String(blob.size), durationMs: String(Math.round(this.state.elapsedMs)) });
    if (!blob.size) { this.fail("AUDIO_EMPTY", "녹음된 내용이 없어요. 다시 녹음해 주세요."); return; }
    if (blob.size > MAX_AUDIO_BYTES) { this.fail("AUDIO_TOO_LARGE", "녹음이 5 MB를 넘었어요. 더 짧게 녹음해 주세요."); return; }
    // Energy threshold is a local silence heuristic, not speech recognition/VAD.
    if (this.audibleFrames < 3) { this.fail("AUDIO_SILENT", "소리가 충분히 들리지 않았어요. 마이크 가까이에서 다시 말해 주세요."); return; }
    const abort = new AbortController();
    this.abort = abort;
    this.update({ phase: "transcribing", bytes: blob.size, message: "음성을 글로 바꾸는 중이에요." });
    this.transcriptionDeadline = setTimeout(() => {
      if (token === this.token) this.fail("TRANSCRIPTION_TIMEOUT", "글로 바꾸는 시간이 오래 걸려요. 다시 시도하거나 글로 질문해 주세요.");
    }, 20_000);
    try {
      const text = await this.transcribe({ blob, mimeType, durationMs: this.state.elapsedMs }, abort.signal);
      if (token !== this.token) return;
      if (!text.trim()) { this.fail("TRANSCRIPT_EMPTY", "인식된 글이 없어요. 다시 녹음하거나 글로 질문해 주세요."); return; }
      this.onTranscript(text);
      this.update({ phase: "review", message: "인식된 문장을 확인하고 수정한 뒤 전송해 주세요." });
    } catch (error) {
      if (token === this.token) this.fail(error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "TRANSCRIPTION_FAILED", error instanceof Error ? error.message : "글로 바꾸지 못했어요. 다시 녹음하거나 글로 질문해 주세요.");
    } finally {
      if (token === this.token) { clearTimeout(this.transcriptionDeadline); this.abort = undefined; this.bytes = 0; }
    }
  }

  cancel() {
    ++this.token;
    this.cleanup();
    this.update({ phase: "idle", elapsedMs: 0, bytes: undefined, mimeType: undefined, code: undefined, message: "취소했어요. 녹음하거나 글로 질문할 수 있어요." });
  }

  dispose() { this.disposed = true; this.cancel(); }
}
