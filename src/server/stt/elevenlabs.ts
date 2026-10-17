import "server-only";
import { audioForm, requestJson, setting } from "./common";
export async function elevenlabs(audio: File, signal: AbortSignal): Promise<string> {
  const body = audioForm(audio);
  body.set("model_id", "scribe_v2"); body.set("language_code", "ko"); body.set("tag_audio_events", "false"); body.set("diarize", "false");
  const data = await requestJson("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": setting("ELEVENLABS_API_KEY") }, body, signal });
  return data.text ?? "";
}
