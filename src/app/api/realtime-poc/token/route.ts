import { NextResponse, type NextRequest } from "next/server";
import { checkSessionOrigin, getSessionHttpConfig } from "@/server/sessions/http";
import { isSessionError } from "@/server/sessions/store";
import { TokenRateLimit, issueConversationToken, readTokenConfig } from "@/server/realtime-poc/token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const state = globalThis as typeof globalThis & { sejongRealtimeTokenLimit?: TokenRateLimit };

export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  try {
    checkSessionOrigin(request, getSessionHttpConfig(request));
  } catch (error) {
    const status = isSessionError(error) ? error.httpStatus : 403;
    return NextResponse.json({ code: "FORBIDDEN", message: "허용된 서비스 화면에서 다시 시도해 주세요." }, { status, headers });
  }
  const config = readTokenConfig();
  state.sejongRealtimeTokenLimit ??= new TokenRateLimit(config.perMinute);
  const result = await issueConversationToken(config, state.sejongRealtimeTokenLimit);
  return NextResponse.json(result.body, { status: result.status, headers });
}
