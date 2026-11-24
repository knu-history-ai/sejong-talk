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
  const pendingClose = useRef<Promise<void>>(Promise.resolve());
  const starting = useRef(false);
  const epoch = useRef(0);
  const disposed = useRef(false);

  const start = useCallback(async () => {
    if (disposed.current || starting.current || controller.current || !canStartVoice(state.phase)) return;
    // state의 다음 렌더보다 먼저 잠근다. SDK import도 이 시작 시도에 포함한다.
    starting.current = true;
    const attempt = ++epoch.current;
    dispatch({ type: "start", at: performance.now() });
    try {
      // BFCache 복귀 후에도 이전 SDK 연결과 endSession 정리가 끝나기 전에는
      // 새 마이크·토큰·SDK 연결을 시작하지 않는다.
      await pendingClose.current;
      if (disposed.current || epoch.current !== attempt) return;
      const startSession = await loadStartSession().catch(() => undefined);
      if (disposed.current || epoch.current !== attempt) return;
      controller.current = startSpeechEngineVoice((event) => {
        if (!disposed.current && epoch.current === attempt) dispatch(event);
      }, {
        getUserMedia: navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices),
        isSecureContext: window.isSecureContext,
        fetchImpl: fetch.bind(window),
        startSession,
      });
    } finally {
      // 취소된 이전 import가 새 시작의 잠금을 풀지 않게 한다.
      if (epoch.current === attempt) starting.current = false;
    }
  }, [state.phase]);

  const stop = useCallback(async () => {
    const stopping = ++epoch.current;
    starting.current = false;
    const current = controller.current;
    controller.current = null;
    if (!disposed.current) dispatch({ type: "endRequested" });
    if (current) pendingClose.current = current.stop();
    await pendingClose.current;
    if (!disposed.current && epoch.current === stopping) {
      dispatch({ type: "disconnected", byUser: true });
    }
  }, []);

  // 오류·연결 끊김으로 끝났으면 오류 안내는 그대로 두고 연결만 정리한다.
  useEffect(() => {
    if (state.phase === "error" || state.phase === "ended") {
      ++epoch.current;
      starting.current = false;
      const current = controller.current;
      controller.current = null;
      if (current) pendingClose.current = current.dispose();
    }
  }, [state.phase]);

  // 화면을 떠나거나 탭을 닫으면 마이크·재생을 확실히 끈다.
  useEffect(() => {
    disposed.current = false;
    const leave = () => {
      disposed.current = true;
      ++epoch.current;
      starting.current = false;
      const current = controller.current;
      controller.current = null;
      if (current) pendingClose.current = current.dispose();
    };
    // 뒤로 가기로 BFCache 화면이 복원되면 자동 재연결하지 않고 새 시작을 허용한다.
    const resume = () => {
      if (!disposed.current) return;
      disposed.current = false;
      dispatch({ type: "disconnected", byUser: true });
    };
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", resume);
    return () => {
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", resume);
      leave();
    };
  }, []);

  return { state, start, stop };
}
