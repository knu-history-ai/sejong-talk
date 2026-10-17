import type { NextRequest } from "next/server";
import { getSpeechHttp } from "@/server/tts/runtime";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return getSpeechHttp().post(request);
}
