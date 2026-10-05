import "server-only";
export function setting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`설정 필요: ${name}`);
  return value;
}
export class SttError extends Error { constructor(message: string, readonly httpStatus?: number) { super(message); } }
export async function requestJsonResponse(url: string, init: RequestInit) {
  const response = await fetch(url, { ...init, cache: "no-store", redirect: "error" });
  if (!response.ok) {
    // Never expose upstream response bodies, URLs, headers, or exception messages.
    const reason = response.status === 401 || response.status === 403 ? "인증/권한 또는 리소스 설정 확인 필요" : response.status === 429 ? "호출 한도 또는 잔액 확인 필요" : response.status === 400 || response.status === 415 || response.status === 422 ? "음성 형식/손상 또는 요청 설정 확인 필요" : "공급자 요청 실패";
    throw new SttError(`${reason} (HTTP ${response.status})`, response.status);
  }
  return { status: response.status, data: await response.json() };
}
export async function requestJson(url: string, init: RequestInit) { return (await requestJsonResponse(url, init)).data; }
export function audioForm(audio: File, field = "file") { const body = new FormData(); body.set(field, audio, audio.name); return body; }
