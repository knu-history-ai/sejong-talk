import "server-only";

import type { AnswerId } from "../../contracts";
import type { SessionHandle } from "../sessions/store";
import {
  synthesizeApprovedAnswer,
  type SynthesizedApprovedAnswer,
} from "./index";

interface SpeechEntry {
  promise: Promise<SynthesizedApprovedAnswer>;
  audio?: SynthesizedApprovedAnswer;
}

export class ApprovedSpeechNotFoundError extends Error {
  readonly code = "REQUEST_NOT_FOUND";
  readonly httpStatus = 404;

  constructor() {
    super("현재 대화에서 재생할 답변을 찾을 수 없습니다.");
    this.name = "ApprovedSpeechNotFoundError";
  }
}

/** Session-local memory only. Share this store between synthesis and audio routes. */
export class ApprovedSpeechStore {
  private readonly sessions = new WeakMap<AbortSignal, Map<AnswerId, SpeechEntry>>();
  private readonly synthesize: typeof synthesizeApprovedAnswer;

  constructor(synthesize = synthesizeApprovedAnswer) {
    this.synthesize = synthesize;
  }

  async getOrCreate(
    session: SessionHandle,
    answerId: AnswerId,
  ): Promise<SynthesizedApprovedAnswer> {
    // getAnswer checks session activity and only returns its stored approved turns.
    const answer = session.getAnswer(answerId);
    if (!answer) throw new ApprovedSpeechNotFoundError();

    let entries = this.sessions.get(session.signal);
    if (!entries) {
      entries = new Map();
      const sessionEntries = entries;
      this.sessions.set(session.signal, entries);
      session.signal.addEventListener("abort", () => {
        sessionEntries.clear();
        this.sessions.delete(session.signal);
      }, { once: true });
    }

    let entry = entries.get(answerId);
    if (!entry) {
      const sessionEntries = entries;
      // Defer provider work until the pending promise is registered, so concurrent
      // calls for the same answer share one synthesis, including synchronous errors.
      const pending: SpeechEntry = {
        promise: Promise.resolve().then(async () => {
          session.assertActive();
          const audio = await this.synthesize(answer, session.signal);
          session.assertActive();
          pending.audio = audio;
          return audio;
        }).catch((error) => {
          sessionEntries.delete(answerId);
          session.assertActive();
          throw error;
        }),
      };
      entries.set(answerId, pending);
      entry = pending;
    }

    const audio = await entry.promise;
    session.assertActive();
    return audio;
  }

  getAudio(session: SessionHandle, answerId: AnswerId): SynthesizedApprovedAnswer | undefined {
    if (!session.getAnswer(answerId)) throw new ApprovedSpeechNotFoundError();
    return this.sessions.get(session.signal)?.get(answerId)?.audio;
  }
}
