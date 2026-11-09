import "server-only";
import { audioForm, requestJson, setting, SttError } from "./common";
export async function clova(audio: File, signal: AbortSignal): Promise<string> {
  const url = new URL(setting("CLOVA_SPEECH_INVOKE_URL"));
  if (url.protocol !== "https:" || url.hostname !== "clovaspeech-gw.ncloud.com" || url.username || url.password || url.port || url.search || url.hash) throw new SttError("CLOVA_SPEECH_INVOKE_URL 설정을 확인해 주세요.");
  // Short recognition uses raw audio and lang=Kor, not the long-form multipart API.
  if (url.pathname === "/recog/v1/stt" || url.pathname === "/recog/v1/stt/") {
    url.pathname = "/recog/v1/stt";
    url.searchParams.set("lang", "Kor");
    const data = await requestJson(url.href, { method: "POST", headers: { "X-CLOVASPEECH-API-KEY": setting("CLOVA_SPEECH_SECRET_KEY"), "Content-Type": "application/octet-stream" }, body: audio, signal });
    return data.text ?? "";
  }
  if (!/^\/external\/v1\/[^/]+\/[^/]+\/?$/.test(url.pathname)) throw new SttError("CLOVA URL은 단문 /recog/v1/stt 또는 장문 /external/v1/도메인/토큰 주소를 사용해 주세요.");
  url.pathname = url.pathname.replace(/\/$/, "") + "/recognizer/upload";
  const body = audioForm(audio, "media");
  body.set("params", JSON.stringify({ language: "ko-KR", completion: "sync", fullText: true, diarization: { enable: false }, resultToObs: false }));
  const data = await requestJson(url.href, { method: "POST", headers: { "X-CLOVASPEECH-API-KEY": setting("CLOVA_SPEECH_SECRET_KEY") }, body, signal });
  if (data.result !== "COMPLETED") throw new SttError("CLOVA 인식 실패: 도메인 설정과 음성 파일을 확인해 주세요.");
  return data.text ?? "";
}
