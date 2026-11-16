import "server-only";
import { audioForm, requestJson, setting } from "./common";
export async function groq(audio: File, signal: AbortSignal): Promise<string> {
  const body = audioForm(audio);
  body.set("model", "whisper-large-v3"); body.set("language", "ko"); body.set("response_format", "json"); body.set("temperature", "0");
  const data = await requestJson("https://api.groq.com/openai/v1/audio/transcriptions", { method: "POST", headers: { Authorization: `Bearer ${setting("GROQ_API_KEY")}` }, body, signal });
  return data.text ?? "";
}
