import "server-only";

/**
 * 실시간 음성 PoC: 브라우저가 Speech Engine에 붙을 때 쓰는 짧은 대화 토큰을 발급한다.
 * ElevenLabs API 키는 서버에만 있고 응답에는 토큰만 담는다.
 *
 * 유료 계정이므로 기본은 꺼져 있다. REALTIME_POC_ENABLED=1 일 때만 동작하고,
 * 같은 출처 화면에서 온 요청만 받으며, 프로세스 단위로 분당 발급 수를 제한한다.
 */

export type TokenResult =
  | { ok: true; status: 200; body: { token: string } }
  | { ok: false; status: number; body: { code: string; message: string } };

export type TokenConfig = {
  enabled: boolean;
  apiKey: string | undefined;
  speechEngineId: string | undefined;
  apiBaseUrl: string;
  perMinute: number;
};

export function readTokenConfig(env: Record<string, string | undefined> = process.env): TokenConfig {
  const perMinute = Number(env.REALTIME_POC_TOKENS_PER_MINUTE ?? "6");
  return {
    enabled: env.REALTIME_POC_ENABLED === "1",
    apiKey: env.ELEVENLABS_API_KEY || undefined,
    speechEngineId: env.ELEVENLABS_SPEECH_ENGINE_ID || undefined,
    apiBaseUrl: (env.ELEVENLABS_API_BASE_URL || "https://api.elevenlabs.io").replace(/\/+$/, ""),
    perMinute: Number.isFinite(perMinute) && perMinute > 0 ? Math.floor(perMinute) : 6,
  };
}

const fail = (status: number, code: string, message: string): TokenResult => ({ ok: false, status, body: { code, message } });

/** 고정 창(1분) 발급 제한. 단일 프로세스 PoC용이며 여러 서버 인스턴스에는 맞지 않는다. */
export class TokenRateLimit {
  private windowStart = 0;
  private count = 0;
  constructor(private readonly perMinute: number, private readonly now: () => number = Date.now) {}
  take(): boolean {
    const t = this.now();
    if (t - this.windowStart >= 60_000) {
      this.windowStart = t;
      this.count = 0;
    }
    if (this.count >= this.perMinute) return false;
    this.count += 1;
    return true;
  }
}

export async function issueConversationToken(
  config: TokenConfig,
  limit: TokenRateLimit,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenResult> {
  if (!config.enabled) {
    return fail(503, "REALTIME_POC_DISABLED", "실시간 음성 시험 설정이 꺼져 있습니다.");
  }
  if (!config.apiKey || !config.speechEngineId) {
    return fail(503, "REALTIME_POC_NOT_CONFIGURED", "실시간 음성 시험 설정이 끝나지 않았습니다.");
  }
  if (!/^seng_[A-Za-z0-9_-]+$/.test(config.speechEngineId)) {
    return fail(503, "REALTIME_POC_NOT_CONFIGURED", "Speech Engine ID 형식을 확인해 주세요.");
  }
  if (!limit.take()) {
    return fail(429, "RATE_LIMITED", "잠시 후 다시 시도해 주세요.");
  }
  const url = `${config.apiBaseUrl}/v1/convai/conversation/token?agent_id=${encodeURIComponent(config.speechEngineId)}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { "xi-api-key": config.apiKey },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return fail(502, "UPSTREAM_UNAVAILABLE", "음성 서버에 연결하지 못했습니다.");
  }
  if (!response.ok) {
    // 공급자 응답 본문에는 계정 정보가 섞일 수 있어 그대로 넘기지 않는다.
    return fail(502, "UPSTREAM_REJECTED", `음성 서버가 요청을 거절했습니다(HTTP ${response.status}).`);
  }
  const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
  if (typeof body?.token !== "string" || !body.token) {
    return fail(502, "UPSTREAM_INVALID", "음성 서버 응답을 확인하지 못했습니다.");
  }
  return { ok: true, status: 200, body: { token: body.token } };
}
