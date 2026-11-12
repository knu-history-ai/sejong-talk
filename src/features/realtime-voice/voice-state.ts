/**
 * 실시간 음성 PoC의 화면 상태. ElevenLabs Speech Engine SDK 이벤트를 이 상태로만 바꿔서
 * 화면(#93/PR #94)은 SDK를 몰라도 되게 한다. 이름은 PR #94의 샘플 이벤트와 맞췄다.
 */
export type VoicePhase =
  | "idle" // 시작 전
  | "requestingMic" // 마이크 권한 확인 중
  | "connecting" // 토큰 발급·연결 중
  | "listening" // 사용자 말을 듣는 중
  | "thinking" // 사용자 말이 끝나고 답변 음성을 기다리는 중 (PR #94의 '답변 준비 중')
  | "speaking" // 답변 음성 재생 중
  | "ending" // 종료 처리 중
  | "ended" // 정상 종료
  | "error";

export type VoiceErrorCode =
  | "micDenied"
  | "micUnavailable"
  | "insecureContext"
  | "pocDisabled"
  | "tokenFailed"
  | "connectFailed"
  | "disconnected";

export const VOICE_ERROR_MESSAGES: Record<VoiceErrorCode, { title: string; message: string }> = {
  micDenied: {
    title: "마이크를 사용할 수 없어요",
    message: "브라우저의 사이트 설정에서 마이크를 허용한 뒤 대화를 다시 시작해 주세요.",
  },
  micUnavailable: {
    title: "마이크를 찾지 못했어요",
    message: "마이크가 연결되어 있는지, 다른 앱이 마이크를 쓰고 있지 않은지 확인해 주세요.",
  },
  insecureContext: {
    title: "보안 연결이 필요해요",
    message: "마이크는 https 주소나 localhost에서만 쓸 수 있어요. 주소를 확인해 주세요.",
  },
  pocDisabled: {
    title: "음성 대화 시험이 꺼져 있어요",
    message: "서버의 실시간 음성 시험 설정(켜기·키·Speech Engine ID)이 끝나지 않았어요. 담당자에게 알려 주세요.",
  },
  tokenFailed: {
    title: "음성 대화를 시작하지 못했어요",
    message: "잠시 후 다시 시도해 주세요. 계속되면 담당자에게 알려 주세요.",
  },
  connectFailed: {
    title: "음성 서버에 연결하지 못했어요",
    message: "네트워크 연결을 확인한 뒤 대화를 다시 시작해 주세요.",
  },
  disconnected: {
    title: "음성 대화 연결이 끊겼어요",
    message: "네트워크 연결을 확인한 뒤 대화를 다시 시작해 주세요.",
  },
};

export type VoiceLine = { role: "user" | "agent"; text: string };

export type VoiceState = {
  phase: VoicePhase;
  error: VoiceErrorCode | null;
  conversationId: string | null;
  lines: VoiceLine[];
  /** 사용자가 답변 도중 끼어든 횟수 (SDK interruption 이벤트 기준) */
  interruptions: number;
  /** 시험 기록용 시각(ms, performance.now 기준). 원문·키는 넣지 않는다. */
  timing: {
    startedAt: number | null;
    connectedAt: number | null;
    lastUserFinalAt: number | null;
    lastAgentAudioAt: number | null;
    lastInterruptionAt: number | null;
    /** user_transcript 이벤트 → speaking 모드 이벤트까지(ms). 실제 말 끝·첫 소리 재생 시각이 아님. 측정 못 하면 null */
    lastResponseLatencyMs: number | null;
  };
};

export type VoiceEvent =
  | { type: "start"; at: number }
  | { type: "micGranted" }
  | { type: "fail"; code: VoiceErrorCode }
  | { type: "connected"; conversationId: string; at: number }
  | { type: "userFinal"; text: string; at: number }
  | { type: "agentText"; text: string }
  | { type: "mode"; mode: "speaking" | "listening"; at: number }
  | { type: "interruption"; at: number }
  | { type: "endRequested" }
  | { type: "disconnected"; byUser: boolean };

export const initialVoiceState: VoiceState = {
  phase: "idle",
  error: null,
  conversationId: null,
  lines: [],
  interruptions: 0,
  timing: {
    startedAt: null,
    connectedAt: null,
    lastUserFinalAt: null,
    lastAgentAudioAt: null,
    lastInterruptionAt: null,
    lastResponseLatencyMs: null,
  },
};

const LIVE: ReadonlySet<VoicePhase> = new Set(["listening", "thinking", "speaking"]);

export function isVoiceLive(phase: VoicePhase) {
  return LIVE.has(phase);
}

export function canStartVoice(phase: VoicePhase) {
  return phase === "idle" || phase === "ended" || phase === "error";
}

export function voiceReducer(state: VoiceState, event: VoiceEvent): VoiceState {
  switch (event.type) {
    case "start":
      if (!canStartVoice(state.phase)) return state;
      return {
        ...initialVoiceState,
        phase: "requestingMic",
        timing: { ...initialVoiceState.timing, startedAt: event.at },
      };
    case "micGranted":
      return state.phase === "requestingMic" ? { ...state, phase: "connecting" } : state;
    case "fail":
      // 사용자가 이미 종료를 눌렀다면 뒤늦은 실패로 오류 화면을 띄우지 않는다.
      if (state.phase === "ending" || state.phase === "ended" || state.phase === "idle") return state;
      return { ...state, phase: "error", error: event.code };
    case "connected":
      if (state.phase !== "connecting") return state;
      return {
        ...state,
        phase: "listening",
        conversationId: event.conversationId,
        timing: { ...state.timing, connectedAt: event.at },
      };
    case "userFinal":
      if (!isVoiceLive(state.phase)) return state;
      return {
        ...state,
        phase: "thinking",
        lines: [...state.lines, { role: "user", text: event.text }],
        timing: { ...state.timing, lastUserFinalAt: event.at, lastResponseLatencyMs: null },
      };
    case "agentText":
      if (!isVoiceLive(state.phase)) return state;
      return { ...state, lines: [...state.lines, { role: "agent", text: event.text }] };
    case "mode": {
      if (!isVoiceLive(state.phase)) return state;
      if (event.mode === "listening") {
        // 답변 대기 중(thinking)에 SDK가 listening을 다시 알려도 대기 표시를 유지한다.
        return state.phase === "speaking" ? { ...state, phase: "listening" } : state;
      }
      const firstAudio = state.phase !== "speaking";
      const latency =
        firstAudio && state.timing.lastUserFinalAt !== null && state.timing.lastResponseLatencyMs === null
          ? Math.max(0, Math.round(event.at - state.timing.lastUserFinalAt))
          : state.timing.lastResponseLatencyMs;
      return {
        ...state,
        phase: "speaking",
        timing: {
          ...state.timing,
          lastAgentAudioAt: firstAudio ? event.at : state.timing.lastAgentAudioAt,
          lastResponseLatencyMs: latency,
        },
      };
    }
    case "interruption":
      if (!isVoiceLive(state.phase)) return state;
      // SDK가 재생을 멈추고 듣기로 돌아간다. 화면도 즉시 '듣는 중'으로 바꾼다.
      return {
        ...state,
        phase: "listening",
        interruptions: state.interruptions + 1,
        timing: { ...state.timing, lastInterruptionAt: event.at },
      };
    case "endRequested":
      if (state.phase === "idle" || state.phase === "ended") return state;
      if (state.phase === "error") return { ...state, phase: "ended", error: null };
      return { ...state, phase: "ending" };
    case "disconnected":
      if (event.byUser || state.phase === "ending") return { ...state, phase: "ended", error: null };
      if (state.phase === "error" || state.phase === "ended" || state.phase === "idle") return state;
      return { ...state, phase: "error", error: "disconnected" };
  }
}
