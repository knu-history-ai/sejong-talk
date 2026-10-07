// Only loaded by the isolated HTTP test server. Never import in application code.
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  if (!String(input).startsWith("https://generativelanguage.googleapis.com/")) return original(input, init);
  // Leave time for HTTP cancellation. No provider network call is made.
  await new Promise(resolve => setTimeout(resolve, 250));
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    kind: "grounded", text: "백성들이 쉽게 뜻을 적도록 훈민정음을 만들었단다.", factIds: ["sejong_hunminjeongeum_purpose"],
  }) }] } }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
};
