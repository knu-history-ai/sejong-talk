import { handleStt } from "@/server/stt/http";
export const runtime = "nodejs";
export async function POST(request: Request) { return handleStt(request, true); }
