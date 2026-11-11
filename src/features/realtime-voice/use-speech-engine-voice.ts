"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";
import { startSpeechEngineVoice, type StartSession, type VoiceController } from "./speech-engine-client";
import { canStartVoice, initialVoiceState, voiceReducer } from "./voice-state";

/** SDK는 브라우저에서만 불러온다(서버 렌더링·테스트에서 WebRTC 의존성을 피함). */
const loadStartSession: () => Promise<StartSession> = async () => {
  const { Conversation } = await import("@elevenlabs/client");
  return (options) => Conversation.startSession(options);
};

/**
 * 실시간 음성 PoC 화면(#93/PR #94)에서 쓰는 훅.
 * state.phase로 '듣는 중'·'답변 준비 중'·'답변 중'을, state.error로 오류 안내를 고른다.
 */
export function useSpeechEngineVoice() {
  const [state, dispatch] = useReducer(voiceReducer, initialVoiceState);
  const controller = useRef<VoiceController | null>(null);

  const start = useCallback(async () => {
    if (controller.current || !canStartVoice(state.phase)) return;
    const startSession = await loadStartSession().catch(() => undefined);
    controller.current = startSpeechEngineVoice(dispatch, {
      getUserMedia: navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices),
      isSecureContext: window.isSecureContext,
      fetchImpl: fetch.bind(window),
      startSession,
    });
  }, [state.phase]);

  const stop = useCallback(async () => {
    const current = controller.current;
    controller.current = null;
    if (current) await current.stop();
    else dispatch({ type: "endRequested" }); // 오류 화면에서 종료 → 종료 화면
  }, []);

  // 오류·연결 끊김으로 끝났으면 오류 안내는 그대로 두고 연결만 정리한다.
  useEffect(() => {
    if (state.phase === "error" || state.phase === "ended") {
      const current = controller.current;
      controller.current = null;
      void current?.dispose();
    }
  }, [state.phase]);

  // 화면을 떠나거나 탭을 닫으면 마이크·재생을 확실히 끈다.
  useEffect(() => {
    const leave = () => {
      const current = controller.current;
      controller.current = null;
      void current?.dispose();
    };
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, []);

  return { state, start, stop };
}
