import type { CreateSessionResponse, TurnRequest, TurnResponse } from "@/contracts";

async function send(url: string, method: string, body?: unknown, signal?: AbortSignal) {
  const response = await fetch(url, { method, credentials: "same-origin", cache: "no-store", signal,
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!result || typeof result.status !== "string") throw new Error("Invalid API response");
  if (!response.ok && result.status !== "failed") throw new Error("API failed");
  return result;
}

export async function createChatSession(): Promise<CreateSessionResponse> {
  const result = await send("/api/sessions", "POST", { characterId: "sejong" });
  if (result.status !== "created") throw new Error(result.message ?? "대화를 시작하지 못했어요.");
  return result;
}
export async function deleteChatSession() {
  const result = await send("/api/sessions/current", "DELETE");
  if (result.status !== "deleted") throw new Error(result.message ?? "대화를 초기화하지 못했어요.");
}
export async function requestTurn(request: TurnRequest, signal: AbortSignal): Promise<TurnResponse> {
  const result = await send("/api/turns", "POST", request, signal);
  if (result.requestId !== request.requestId || !["approved", "failed", "cancelled"].includes(result.status)) throw new Error("Invalid turn response");
  if (result.status === "approved" && (!result.answer || typeof result.answer.text !== "string" || !Array.isArray(result.answer.sources))) throw new Error("Invalid answer");
  return result;
}
export async function cancelTurn(id: string) { await send(`/api/requests/${encodeURIComponent(id)}`, "DELETE"); }
