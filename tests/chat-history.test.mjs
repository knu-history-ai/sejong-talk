import test from "node:test";
import assert from "node:assert/strict";
import { loadTs } from "./helpers/load-ts.mjs";
const { readSavedChats, saveChat, clearSavedChats, CHAT_HISTORY_KEY } = loadTs("src/features/chat/chat-history.ts");
function storage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
}
function chat(id) {
  return { id, title: "세종의 업적", savedAt: "2026-10-07T00:00:00Z", sample: false, turns: [
    { question: "업적은?", status: "answered", answer: { answerId: "answer-1", text: "답변", sources: [{ id: "source-1", title: "출처", institution: "기관", url: "https://example.org" }] } },
    { question: "이어서 질문", status: "loading", answer: null },
  ] };
}
test("saved chats retain answers and sources across storage reads without changing active turns", () => {
  const disk = storage();
  const current = chat("one");
  saveChat(disk, current);
  const [saved] = readSavedChats(disk);
  assert.equal(saved.turns[0].answer.sources[0].url, "https://example.org");
  assert.equal(saved.turns[1].status, "cancelled");
  assert.equal(current.turns[1].status, "loading");
  saveChat(disk, current);
  assert.equal(readSavedChats(disk).length, 1);
});
test("archives keep newest thirty chats and skip empty conversations", () => {
  const disk = storage();
  for (let i = 0; i < 31; i++) saveChat(disk, chat(String(i)));
  assert.equal(readSavedChats(disk).length, 30);
  assert.equal(readSavedChats(disk)[0].id, "30");
  saveChat(disk, { ...chat("empty"), turns: [] });
  assert.equal(readSavedChats(disk)[0].id, "30");
});
test("corrupted or unavailable storage fails without overwriting existing records", () => {
  const disk = storage();
  disk.setItem(CHAT_HISTORY_KEY, "broken-json");
  assert.throws(() => saveChat(disk, chat("one")));
  assert.equal(disk.getItem(CHAT_HISTORY_KEY), "broken-json");
  assert.throws(() => saveChat({ getItem: () => null, setItem: () => { throw new Error("Quota"); } }, chat("one")));
});

test("delete clears all archived chats while retaining unrelated preferences and is idempotent", () => {
  const disk = storage();
  disk.setItem("other-preference", "keep");
  saveChat(disk, chat("one"));
  clearSavedChats(disk);
  assert.deepEqual(readSavedChats(disk), []);
  assert.equal(disk.getItem("other-preference"), "keep");
  clearSavedChats(disk);
  assert.deepEqual(readSavedChats(disk), []);
});
