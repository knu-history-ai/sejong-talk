// Only loaded by the isolated HTTP test server. Never import in application code.
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("http://127.0.0.1:11434/api/generate")) return original(input, init);
  // Leave time for HTTP cancellation. No provider network call is made.
  await new Promise(resolve => setTimeout(resolve, 250));
  if (JSON.parse(init.body).prompt.startsWith("역사 답변 공개 전")) {
    return Response.json({ response: JSON.stringify({ verdict: "supported", factIds: ["sejong_hunminjeongeum_purpose"] }), prompt_eval_count: 20, eval_count: 4 });
  }
  return Response.json({ response: JSON.stringify({
    kind: "grounded", text: "백성들이 쉽게 뜻을 적도록 훈민정음을 만들었단다.", factIds: ["sejong_hunminjeongeum_purpose"],
  }), prompt_eval_count: 10, eval_count: 5 });
};
