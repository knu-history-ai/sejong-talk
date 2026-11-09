import "server-only";

import type { NextRequest } from "next/server";
import type { Answer } from "../../contracts";
import { getSessionHttpConfig, requireSession, sessionErrorResponse } from "../sessions/http";
import { SessionError, type SessionStore } from "../sessions/store";

const greeting: Answer = {
  answerId: "tts_test_greeting", kind: "conversation",
  text: "반갑구나. 무엇이 궁금하니?",
  factIds: [], sources: [], personaVersion: "tts-dev", contentVersion: "tts-dev",
};

/** Fixed, reviewed greeting for local TTS integration; never accepts client text. */
export async function prepareTtsTestAnswer(request: NextRequest, store: SessionStore): Promise<Response> {
  if (process.env.NODE_ENV !== "development") {
    return Response.json({ message: "개발 환경에서만 사용할 수 있습니다." }, {
      status: 404, headers: { "Cache-Control": "no-store" },
    });
  }
  try {
    const session = requireSession(request, store, getSessionHttpConfig(request));
    const reader = request.body?.getReader();
    if (reader) {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value.byteLength > 0) {
            void reader.cancel().catch(() => {});
            throw new SessionError("INVALID_INPUT", 400, "시험 답변은 서버의 고정된 인사문만 사용합니다.");
          }
        }
      } finally {
        reader.releaseLock();
      }
    }
    const answer = session.getAnswer(greeting.answerId);
    if (!answer) {
      session.appendApprovedTurn({ userText: "안녕하세요", answer: greeting });
    }
    const { sessionId } = session.assertActive();
    return Response.json({ sessionId, answer: answer ?? greeting }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return sessionErrorResponse(error);
  }
}
