import "server-only";
import { createHash } from "node:crypto";
import { compare, selectedProvider, transcribe } from "./index";

const MAX_BODY = 5_100_000;
class InputError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
const jobs = new Map<string, { hash: string; expires: number; response: Promise<Response> }>();
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function readAudio(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new InputError("음성 파일이 없어요.");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY) { await reader.cancel(); throw new InputError("음성 파일은 최대 5 MB까지 사용할 수 있어요.", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = Buffer.concat(chunks);
  let form: FormData;
  try { form = await new Response(body, { headers: { "Content-Type": request.headers.get("content-type") || "" } }).formData(); }
  catch { throw new InputError("올바른 음성 업로드 요청이 아니에요."); }
  const requestId = form.get("requestId");
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(requestId)) throw new InputError("요청 번호가 올바르지 않아요.");
  const audio = form.get("audio");
  if (!(audio instanceof File) || !audio.size) throw new InputError("녹음된 내용이 없어요.");
  if (audio.size > 5_000_000) throw new InputError("음성 파일은 최대 5 MB까지 사용할 수 있어요.", 413);
  const mime = audio.type.split(";")[0];
  const extensions: Record<string, string> = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mpeg": "mp3", "audio/flac": "flac" };
  if (!extensions[mime]) throw new InputError("지원하지 않는 음성 형식이에요.", 415);
  const data = Buffer.from(await audio.arrayBuffer());
  const magic = mime === "audio/webm" ? data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : mime === "audio/ogg" ? data.toString("ascii", 0, 4) === "OggS" : mime === "audio/mp4" ? data.toString("ascii", 4, 8) === "ftyp" : mime.includes("wav") ? data.toString("ascii", 0, 4) === "RIFF" && data.toString("ascii", 8, 12) === "WAVE" : mime === "audio/flac" ? data.toString("ascii", 0, 4) === "fLaC" : data.toString("ascii", 0, 3) === "ID3" || (data[0] === 255 && (data[1] & 224) === 224);
  if (!magic || data.length < 16) throw new InputError("음성 파일이 손상되었거나 형식이 일치하지 않아요.");
  // Container signatures are not full decoding; providers also validate the payload.
  return { requestId, audio: new File([data], `recording.${extensions[mime]}`, { type: mime }), hash: createHash("sha256").update(mime).update(data).digest("hex") };
}

export async function handleStt(request: Request, comparison = false): Promise<Response> {
  // Session/auth infrastructure is not implemented in this repository yet.
  // Never expose a paid, anonymous transcription endpoint in a production build.
  if (process.env.NODE_ENV !== "development") return json({ message: "개발 환경에서만 사용할 수 있어요." }, 404);
  const origin = request.headers.get("origin");
  let sameOrigin = false;
  try { sameOrigin = !!origin && new URL(origin).host === request.headers.get("host"); } catch { /* Reject malformed origins. */ }
  if (!sameOrigin) return json({ message: "같은 사이트에서 요청해 주세요." }, 403);
  let requestId: string | null = null;
  try {
    const input = await readAudio(request);
    requestId = input.requestId;
    const provider = comparison ? undefined : selectedProvider();
    if (!comparison && !provider) return json({ status: "failed", code: "UNAVAILABLE", requestId, retryable: false, message: "비교 후 STT_PROVIDER를 설정해 주세요." }, 503);
    for (const [key, job] of jobs) if (job.expires < Date.now()) jobs.delete(key);
    const key = `${comparison ? "compare" : provider}:${requestId}`;
    const prior = jobs.get(key);
    if (prior) {
      if (prior.hash !== input.hash) return json({ status: "failed", code: "REQUEST_CONFLICT", requestId, retryable: false, message: "같은 요청 번호에 다른 음성이 들어왔어요." }, 409);
      return (await prior.response).clone();
    }
    if (jobs.size >= 100) return json({ message: "요청이 많아요. 잠시 후 다시 시도해 주세요." }, 429);
    const response = (async () => {
      if (comparison) return json({ results: await compare(input.audio, request.signal) });
      const result = await transcribe(provider!, input.audio, request.signal);
      return result.success ? json({ requestId, operation: "transcription", status: "completed", text: result.text }) : json({ status: "failed", requestId, code: "UNAVAILABLE", retryable: true, message: result.error }, 502);
    })();
    jobs.set(key, { hash: input.hash, expires: Date.now() + 60_000, response });
    const expiry = setTimeout(() => jobs.delete(key), 60_000); expiry.unref();
    return (await response).clone();
  } catch (error) {
    return json({ status: "failed", code: "INVALID_INPUT", requestId, retryable: false, message: error instanceof InputError ? error.message : "요청을 처리하지 못했어요." }, error instanceof InputError ? error.status : 400);
  }
}
