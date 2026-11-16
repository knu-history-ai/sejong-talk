import type { Answer, ApiError } from "@/contracts";

export type ConversationStatus = "loading" | "failed" | "answered" | "cancelled";
export type Conversation = { question: string; answer: Answer | null; error?: ApiError; status: ConversationStatus };
export interface SavedChat {
  id: string;
  title: string;
  savedAt: string;
  sample: boolean;
  turns: Conversation[];
}
export const CHAT_HISTORY_KEY = "sejong-chat-history-v1";
export const MAX_SAVED_CHATS = 30;
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function clearSavedChats(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(CHAT_HISTORY_KEY);
}

export function readSavedChats(storage: StorageLike): SavedChat[] {
  const raw = storage.getItem(CHAT_HISTORY_KEY);
  if (raw === null) return [];
  const data: unknown = JSON.parse(raw);
  if (!Array.isArray(data) || !data.every((chat) => chat && typeof chat.id === "string" &&
    typeof chat.title === "string" && typeof chat.savedAt === "string" && Number.isFinite(Date.parse(chat.savedAt)) &&
    typeof chat.sample === "boolean" && Array.isArray(chat.turns) && chat.turns.every((turn: Conversation) =>
      turn && typeof turn.question === "string" && ["failed", "answered", "cancelled"].includes(turn.status) &&
      (turn.answer === null || (typeof turn.answer?.text === "string" && Array.isArray(turn.answer.sources) && turn.answer.sources.every((source) =>
        source && typeof source.id === "string" && typeof source.title === "string" && typeof source.institution === "string" && typeof source.url === "string")))))) {
    throw new Error("Invalid saved chats");
  }
  return data.slice(0, MAX_SAVED_CHATS);
}

export function saveChat(storage: StorageLike, chat: SavedChat): SavedChat[] {
  const previous = readSavedChats(storage);
  if (!chat.turns.length) return previous;
  const next = [{ ...chat, turns: chat.turns.map((turn) => ({ ...turn, status: turn.status === "loading" ? "cancelled" as const : turn.status })) },
    ...previous.filter((item) => item.id !== chat.id)].slice(0, MAX_SAVED_CHATS);
  storage.setItem(CHAT_HISTORY_KEY, JSON.stringify(next));
  return next;
}
