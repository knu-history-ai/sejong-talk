import "server-only";
import { requestJson, setting } from "./common";
export async function deepgram(audio: File, signal: AbortSignal): Promise<string> {
  const data = await requestJson("https://api.deepgram.com/v1/listen?model=nova-3&language=ko&smart_format=true", { method: "POST", headers: { Authorization: `Token ${setting("DEEPGRAM_API_KEY")}`, "Content-Type": audio.type }, body: audio, signal });
  return data.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}
