import { NextRequest } from "next/server";
import { createSessionResponse, getSessionHttpConfig, sessionErrorResponse } from "@/server/sessions/http";
import { getSessionStore } from "@/server/sessions/runtime";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    return await createSessionResponse(request, getSessionStore(), getSessionHttpConfig(request));
  } catch (error) {
    return sessionErrorResponse(error);
  }
}
