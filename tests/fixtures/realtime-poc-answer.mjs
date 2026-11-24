// Local WS contract fixture: no model or provider calls.
export async function* answer({ transcript }) {
  const text = transcript.at(-1)?.content;
  if (text === "fail-before-chunk") throw new Error("PRIVATE_PROVIDER_DETAIL");
  if (text === "fail-after-chunk") {
    yield "partial";
    throw new Error("PRIVATE_PROVIDER_DETAIL");
  }
  yield "next-answer";
}
