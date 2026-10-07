import type { NextRequest } from "next/server";
import { handleTurn } from "@/server/ai/http";
export const runtime = "nodejs";
export function POST(request: NextRequest) { return handleTurn(request); }
