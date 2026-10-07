import type { NextRequest } from "next/server";
import { getSessionStore } from "@/server/sessions/runtime";
import { prepareTtsTestAnswer } from "@/server/tts/dev-answer";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return prepareTtsTestAnswer(request, getSessionStore());
}
