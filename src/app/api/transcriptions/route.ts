import type { NextRequest } from "next/server";
import { getTranscriptionHttp } from "@/server/stt/runtime";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  return getTranscriptionHttp().post(request);
}
