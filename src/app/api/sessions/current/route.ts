import { NextRequest } from "next/server";
import { deleteSessionResponse, getSessionHttpConfig, sessionErrorResponse } from "@/server/sessions/http";
import { getSessionStore } from "@/server/sessions/runtime";

export const runtime = "nodejs";

export function DELETE(request: NextRequest) {
  try {
    return deleteSessionResponse(request, getSessionStore(), getSessionHttpConfig(request));
  } catch (error) {
    return sessionErrorResponse(error);
  }
}
