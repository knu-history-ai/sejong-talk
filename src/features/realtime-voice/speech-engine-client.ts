import type { VoiceErrorCode, VoiceEvent } from "./voice-state";

/**
 * 브라우저 ↔ ElevenLabs Speech Engine 연결.
 * - 마이크: 먼저 getUserMedia로 권한·장치를 확인한 뒤 바로 놓고, 실제 녹음·전송은 SDK가 맡는다.
 * - 음성: SDK(WebRTC)가 마이크 전송·답변 재생·끼어들기 감지를 한다.
 * - 끼어들기: 서버가 interruption 이벤트를 보내면 SDK가 재생을 멈춘다(output.interrupt).
 *   여기서는 그 이벤트를 화면 상태로 바꾸고, 시각만 기록한다.
 * API 키는 브라우저로 오지 않는다. 서버(/api/realtime-poc/token)가 짧게 쓰는 토큰만 준다.
 */

export const TOKEN_ENDPOINT = "/api/realtime-poc/token";

/** SDK에서 실제로 쓰는 부분만. 테스트에서 가짜로 바꿀 수 있게 최소로 둔다. */
export type VoiceSessionHandle = { endSession(): Promise<void> };

export type SdkCallbacks = {
  onConnect?: (props: { conversationId: string }) => void;
  onDisconnect?: (details: { reason: "error" | "agent" | "user"; message?: string }) => void;
  onError?: (message: string, context?: unknown) => void;
  onMessage?: (props: { message: string; role?: string; source?: string }) => void;
  onModeChange?: (prop: { mode: "speaking" | "listening" }) => void;
  onInterruption?: (props: { event_id: number }) => void;
};

export type StartSession = (options: {
  conversationToken: string;
  connectionType: "webrtc";
} & SdkCallbacks) => Promise<VoiceSessionHandle>;

export type SpeechEngineDeps = {
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  isSecureContext?: boolean;
  fetchImpl?: typeof fetch;
  startSession?: StartSession;
  now?: () => number;
};

export class VoiceStartError extends Error {
  constructor(readonly code: VoiceErrorCode, message?: string) {
    super(message ?? code);
    this.name = "VoiceStartError";
  }
}

/** getUserMedia 오류 이름 → 화면 오류 코드 */
export function classifyMicError(error: unknown): VoiceErrorCode {
  const name = typeof error === "object" && error && "name" in error ? String(error.name) : "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return "micDenied";
  return "micUnavailable";
}

export async function checkMicrophone(deps: SpeechEngineDeps): Promise<void> {
  if (deps.isSecureContext === false) throw new VoiceStartError("insecureContext");
  if (!deps.getUserMedia) throw new VoiceStartError("micUnavailable");
  let stream: MediaStream;
  try {
    stream = await deps.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    throw new VoiceStartError(classifyMicError(error));
  }
  // 권한만 확인하고 바로 놓는다. SDK가 세션 시작 때 다시 연다.
  for (const track of stream.getTracks()) track.stop();
}

export async function fetchConversationToken(fetchImpl: typeof fetch, signal?: AbortSignal): Promise<string> {
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new VoiceStartError("tokenFailed");
  }
  if (response.status === 404 || response.status === 503) {
    const body = await response.json().catch(() => null);
    if (body?.code === "REALTIME_POC_DISABLED" || body?.code === "REALTIME_POC_NOT_CONFIGURED") throw new VoiceStartError("pocDisabled");
    throw new VoiceStartError("tokenFailed");
  }
  if (!response.ok) throw new VoiceStartError("tokenFailed");
  const body = await response.json().catch(() => null);
  if (typeof body?.token !== "string" || !body.token) throw new VoiceStartError("tokenFailed");
  return body.token;
}

export type VoiceController = {
  /** 사용자가 종료를 누름. 여러 번 불러도 안전하다. */
  stop(): Promise<void>;
  /** 화면 상태는 그대로 두고 연결·마이크만 정리한다(오류 뒤 정리, 화면 이탈). */
  dispose(): Promise<void>;
};

/**
 * 대화를 시작한다. 상태 변화는 모두 dispatch로 알린다.
 * 반환된 controller.stop()으로 끝낸다. 시작 도중 stop()을 부르면 연결되자마자 닫는다.
 */
export function startSpeechEngineVoice(onEvent: (event: VoiceEvent) => void, deps: SpeechEngineDeps): VoiceController {
  const now = deps.now ?? (() => performance.now());
  const abort = new AbortController();
  let session: VoiceSessionHandle | null = null;
  let stopped = false;
  let silent = false; // dispose() 뒤에는 SDK 이벤트로 화면을 바꾸지 않는다.

  const dispatch = (event: VoiceEvent) => {
    if (!silent) onEvent(event);
  };

  dispatch({ type: "start", at: now() });

  const ready = (async () => {
    try {
      await checkMicrophone(deps);
      if (stopped) return;
      dispatch({ type: "micGranted" });
      if (!deps.fetchImpl || !deps.startSession) throw new VoiceStartError("connectFailed");
      const token = await fetchConversationToken(deps.fetchImpl, abort.signal);
      if (stopped) return;
      let started: VoiceSessionHandle;
      try {
        started = await deps.startSession({
          conversationToken: token,
          connectionType: "webrtc",
          onConnect: ({ conversationId }) => dispatch({ type: "connected", conversationId, at: now() }),
          onDisconnect: (details) => dispatch({ type: "disconnected", byUser: stopped || details.reason === "user" }),
          onError: () => {
            if (!stopped) dispatch({ type: "fail", code: "connectFailed" });
          },
          onMessage: ({ message, role, source }) => {
            const text = message?.trim();
            if (!text) return;
            const fromUser = role === "user" || source === "user";
            dispatch(fromUser ? { type: "userFinal", text, at: now() } : { type: "agentText", text });
          },
          onModeChange: ({ mode }) => dispatch({ type: "mode", mode, at: now() }),
          onInterruption: () => dispatch({ type: "interruption", at: now() }),
        });
      } catch (error) {
        throw error instanceof VoiceStartError ? error : new VoiceStartError("connectFailed");
      }
      // 연결 중에 종료를 눌렀다면 여기서 한 번만 닫는다(close()가 다시 닫지 않도록 session에 넣지 않음).
      if (stopped) await started.endSession().catch(() => undefined);
      else session = started;
    } catch (error) {
      if (stopped) return;
      dispatch({ type: "fail", code: error instanceof VoiceStartError ? error.code : "connectFailed" });
    }
  })();

  async function close() {
    abort.abort();
    await ready;
    const current = session;
    session = null;
    if (current) await current.endSession().catch(() => undefined);
  }

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      dispatch({ type: "endRequested" });
      await close();
      dispatch({ type: "disconnected", byUser: true });
    },
    async dispose() {
      if (stopped) return;
      stopped = true;
      silent = true;
      await close();
    },
  };
}
