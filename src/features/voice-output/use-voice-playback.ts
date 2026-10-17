"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  PlaybackController,
  type PlaybackState,
} from "./playback-controller";

const initialState: PlaybackState = { status: "idle", speed: 1 };

export function useVoicePlayback() {
  const [state, setState] = useState<PlaybackState>(initialState);
  const controller = useRef<PlaybackController | null>(null);
  const mounted = useRef(true);

  const getController = useCallback(() => {
    if (!controller.current) {
      controller.current = new PlaybackController({
        createAudio: (url) => new Audio(url),
        createObjectUrl: (blob) => URL.createObjectURL(blob),
        revokeObjectUrl: (url) => URL.revokeObjectURL(url),
        onStateChange: (nextState) => {
          if (mounted.current) setState(nextState);
        },
      });
    }
    return controller.current;
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.reset();
      controller.current = null;
    };
  }, []);

  const play = useCallback(
    (blob: Blob) => getController().play(blob),
    [getController],
  );
  const stop = useCallback(() => controller.current?.stop(), []);
  const replay = useCallback(
    () => controller.current?.replay() ?? Promise.resolve(),
    [],
  );
  const setSpeed = useCallback(
    (speed: number) => getController().setSpeed(speed),
    [getController],
  );
  const reset = useCallback(() => {
    controller.current?.reset();
    if (!controller.current) setState(initialState);
  }, []);

  return {
    ...state,
    play,
    stop,
    replay,
    setSpeed,
    reset,
  };
}
