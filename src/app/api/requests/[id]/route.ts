import type { NextRequest } from "next/server";
import { handleRequest } from "@/server/ai/http";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: NextRequest, context: Context) { return handleRequest(request, (await context.params).id); }
export async function DELETE(request: NextRequest, context: Context) { return handleRequest(request, (await context.params).id, true); }
