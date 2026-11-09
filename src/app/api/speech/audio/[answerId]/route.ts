import type { NextRequest } from "next/server";
import { getSpeechHttp } from "@/server/tts/runtime";

export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ answerId: string }> },
) {
  const { answerId } = await params;
  return getSpeechHttp().getAudio(request, answerId);
}
