import test from "node:test";
import assert from "node:assert/strict";
import { approved, mountChat, textContent } from "./helpers/chat-lifecycle.mjs";

// Compare without editing either implementation:
// CHAT_LIFECYCLE_SOURCE_ROOT=/path/to/pr51-source node --test tests/chat-lifecycle.test.mjs
function setup(t) {
  const app = mountChat();
  t.after(() => app.dispose());
  return app;
}

async function start(app) {
  await app.click("세종대왕 만나기");
  await app.settle();
}

async function ask(app, question, response) {
  if (response) app.api.enqueue("POST", "/api/turns", response);
  app.type(question);
  app.submit();
  await app.settle();
}

async function reset(app) {
  app.click("새 대화");
  await app.click("새로 시작하기");
  await app.settle();
}

function hasText(app, text) {
  return app.all((node) => node.type === "p" && textContent(node) === text).length > 0;
}

const retryableFailure = { status: "failed", code: "UNAVAILABLE", message: "잠시 후 다시 시도해 주세요.", retryable: true };

for (const key of ["sejong-chat-history-v1", "sejong-chat-clear"]) {
  test(`intro receives other-tab deletion (${key}) without resurrecting deleted turns`, async (t) => {
    const app = setup(t);
    await start(app);
    await ask(app, "먼저 보관할 질문");
    await reset(app);
    assert.equal(app.savedChats().length, 1);
    await ask(app, "소개 화면에 남아 있던 질문");
    app.click("세종톡 소개 화면");
    assert.equal(app.isChat(), false);

    app.storage.removeItem(app.historyKey);
    app.otherTabStorage(key, key === app.historyKey ? null : "other-tab-clear");
    await start(app);
    assert.deepEqual(app.savedChats(), [], "restart must not archive turns that another tab deleted");
    assert.deepEqual(app.questions(), []);
  });
}

test("session change preserves completed/failed turns for archival on recovery", async (t) => {
  const app = setup(t);
  await start(app);
  const answer = approved("원래 답변과 출처");
  await ask(app, "성공한 질문", answer);
  await ask(app, "실패한 질문", retryableFailure);

  app.otherTabStorage("sejong-session-change", "replacement-session");
  assert.deepEqual(app.questions(), ["성공한 질문", "실패한 질문"], "session change must not erase the transcript");
  assert.equal(hasText(app, answer.answer.text), true);
  assert.equal(app.textarea().props.disabled, true);
  await app.click("새 대화 시작하기");
  await app.settle();
  assert.deepEqual(app.savedChats()[0].turns.map((turn) => [turn.question, turn.status, turn.answer, turn.error?.message ?? null]), [
    ["성공한 질문", "answered", answer.answer, null],
    ["실패한 질문", "failed", null, retryableFailure.message],
  ]);
});

test("session change cancels the pending turn without losing earlier answers or accepting late replies", async (t) => {
  const app = setup(t);
  await start(app);
  const answer = approved("이미 완료된 답변");
  await ask(app, "완료된 질문", answer);
  const pending = app.api.deferNext("POST", "/api/turns");
  await ask(app, "처리 중인 질문");
  const request = app.api.calls.at(-1);

  app.otherTabStorage("sejong-session-change", "another-session");
  assert.equal(request.signal.aborted, true);
  pending.resolve(approved("늦게 도착한 답변"));
  await app.settle();
  assert.deepEqual(app.questions(), ["완료된 질문", "처리 중인 질문"]);
  assert.equal(hasText(app, "답변 준비를 멈췄어요."), true);
  assert.equal(hasText(app, "늦게 도착한 답변"), false);
  await app.click("새 대화 시작하기");
  await app.settle();
  assert.deepEqual(app.savedChats()[0].turns.map((turn) => [turn.question, turn.status, turn.answer]), [
    ["완료된 질문", "answered", answer.answer],
    ["처리 중인 질문", "cancelled", null],
  ]);
});

test("session notification storage failure does not prevent successful start and subsequent question", async (t) => {
  const app = setup(t);
  app.storage.failedWrites.add("sejong-session-change");
  await start(app);
  assert.equal(app.isChat(), true, "successful API creation must open the conversation");
  assert.equal(app.storage.writes.some((write) => write.key === "sejong-session-change" && write.failed), true);
  await ask(app, "저장 알림이 실패해도 질문 가능");
  assert.equal(hasText(app, approved().answer.text), true);
});

test("session notification storage failure does not interrupt reset after deletion", async (t) => {
  const app = setup(t);
  await start(app);
  const answer = approved("보관할 답변");
  await ask(app, "보관할 질문", answer);
  app.storage.failedWrites.add("sejong-session-change");
  await reset(app);
  assert.equal(app.api.count("POST", "/api/sessions"), 2, "reset must create a replacement session despite notification failure");
  assert.equal(app.storage.writes.at(-1).failed, true);
  assert.deepEqual(app.questions(), []);
  assert.deepEqual(app.savedChats()[0].turns[0].answer, answer.answer);
  await ask(app, "초기화 후 새 질문");
  assert.deepEqual(app.questions(), ["초기화 후 새 질문"]);
});

for (const action of ["ask", "retry"]) {
  test(`delayed delete blocks queued ${action} before rerender`, async (t) => {
    const app = setup(t);
    await start(app);
    await ask(app, "삭제할 질문", action === "retry" ? retryableFailure : approved());
    if (action === "ask") app.type("삭제 중 보내면 안 되는 질문");
    const queued = action === "ask" ? app.form().props.onSubmit : app.button("다시 시도").props.onClick;
    app.click("이전 대화");
    app.click("모든 대화 기록 삭제");
    const deletion = app.api.deferNext("DELETE", "/api/sessions/current");
    const before = app.api.count("POST", "/api/turns");

    // The old handler fires before the disabled UI is committed.
    const deleting = app.button("모두 삭제하기").props.onClick();
    queued({ preventDefault() {} });
    app.flush();
    await app.settle();
    assert.equal(app.api.count("POST", "/api/turns"), before, "delete must block new requests synchronously");
    assert.deepEqual(app.questions(), [], "a blocked handler must not append a loading turn");
    assert.equal(app.textarea().props.disabled, true);
    deletion.resolve({ status: "deleted" });
    await deleting;
    await app.settle();
    assert.equal(app.isChat(), false);
  });
}
