import "server-only";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Answer, ErrorCode } from "../../contracts/index.ts";

export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
// Initial single-process trial: increase only after measuring memory and latency.
export const MAX_ACTIVE_SESSIONS = 5;
export const MAX_COMPLETED_TURNS = 30;
const SESSION_ERROR = Symbol.for("sejong.session.error");
const ERROR_STATUS = { INVALID_INPUT: 400, SESSION_EXPIRED: 401, FORBIDDEN: 403,
  REQUEST_CONFLICT: 409, LIMIT_EXCEEDED: 429, UNAVAILABLE: 503 } as const;

export class SessionError extends Error {
  readonly [SESSION_ERROR] = true;
  readonly code: ErrorCode;
  readonly httpStatus: number;

  constructor(code: ErrorCode, httpStatus: number, message: string) {
    super(message);
    this.name = "SessionError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

/** The process-global store may retain an older module instance after hot reload. */
export function isSessionError(error: unknown): error is SessionError {
  if (!(error instanceof Error) || !(SESSION_ERROR in error) || error[SESSION_ERROR] !== true ||
      !("code" in error) || typeof error.code !== "string" || !("httpStatus" in error)) return false;
  return Object.hasOwn(ERROR_STATUS, error.code) &&
    ERROR_STATUS[error.code as keyof typeof ERROR_STATUS] === error.httpStatus;
}

export interface SessionSnapshot {
  sessionId: string;
  characterId: "sejong";
  createdAt: number;
  lastActivityAt: number;
  expiresAt: number;
}
export interface CompletedTurn {
  userText: string;
  answer: Answer;
}
export interface SessionHandle {
  /** Recheck after every asynchronous operation, immediately before committing a result. */
  assertActive(): SessionSnapshot;
  readonly signal: AbortSignal;
  getRecentTurns(): CompletedTurn[];
  getAnswer(answerId: string): Answer | undefined;
  /** Only call with an answer already approved by the answer-validation pipeline. */
  appendApprovedTurn(turn: CompletedTurn): void;
}
interface Entry {
  sessionId: string;
  characterId: "sejong";
  createdAt: number;
  lastActivityAt: number;
  controller: AbortController;
  turns: CompletedTurn[];
  timer?: ReturnType<typeof setTimeout>;
}
interface Options {
  now?: () => number;
  idleTimeoutMs?: number;
  absoluteTimeoutMs?: number;
  maxSessions?: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly absoluteTimeoutMs: number;
  private readonly maxSessions: number;

  constructor(options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
    this.absoluteTimeoutMs = options.absoluteTimeoutMs ?? ABSOLUTE_TIMEOUT_MS;
    this.maxSessions = options.maxSessions ?? MAX_ACTIVE_SESSIONS;
    for (const value of [this.idleTimeoutMs, this.absoluteTimeoutMs, this.maxSessions]) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid session limits");
    }
  }

  private key(token: string | undefined): string | undefined {
    // A public session UUID is deliberately not a valid bearer token.
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    return createHash("sha256").update(token).digest("hex");
  }

  private expiresAt(entry: Entry): number {
    return Math.min(
      entry.lastActivityAt + this.idleTimeoutMs,
      entry.createdAt + this.absoluteTimeoutMs,
    );
  }

  private snapshot(entry: Entry): SessionSnapshot {
    return {
      sessionId: entry.sessionId,
      characterId: entry.characterId,
      createdAt: entry.createdAt,
      lastActivityAt: entry.lastActivityAt,
      expiresAt: this.expiresAt(entry),
    };
  }

  private remove(key: string, entry: Entry): void {
    this.sessions.delete(key);
    clearTimeout(entry.timer);
    entry.turns.length = 0;
    entry.controller.abort();
  }

  private live(key: string | undefined): Entry | undefined {
    if (!key) return undefined;
    const entry = this.sessions.get(key);
    if (entry && this.now() >= this.expiresAt(entry)) {
      this.remove(key, entry);
      return undefined;
    }
    return entry;
  }

  private scheduleExpiry(key: string, entry: Entry): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      if (this.live(key) === entry) this.scheduleExpiry(key, entry);
    }, Math.max(1, this.expiresAt(entry) - this.now()));
    entry.timer.unref();
  }

  create(previousToken?: string): { token: string; session: SessionSnapshot } {
    for (const key of this.sessions.keys()) this.live(key);
    const previousKey = this.key(previousToken);
    const previous = this.live(previousKey);
    if (this.sessions.size >= this.maxSessions && !previous) {
      throw new SessionError("UNAVAILABLE", 503, "현재 대화 인원이 많습니다. 잠시 후 다시 시작해 주세요.");
    }
    // No await between replacing the old session and inserting the new one.
    const token = randomBytes(32).toString("base64url");
    const key = this.key(token)!;
    const now = this.now();
    const entry: Entry = {
      sessionId: randomUUID(), characterId: "sejong", createdAt: now,
      lastActivityAt: now, controller: new AbortController(), turns: [],
    };
    if (previous && previousKey) this.remove(previousKey, previous);
    this.sessions.set(key, entry);
    this.scheduleExpiry(key, entry);
    return { token, session: this.snapshot(entry) };
  }

  authenticate(token: string | undefined, touch = true): SessionHandle {
    const key = this.key(token);
    const entry = this.live(key);
    if (!entry || !key) throw this.expired();
    if (touch) {
      entry.lastActivityAt = this.now();
      this.scheduleExpiry(key, entry);
    }
    const assertActive = () => {
      if (this.live(key) !== entry) throw this.expired();
      return this.snapshot(entry);
    };
    return {
      assertActive,
      signal: entry.controller.signal,
      getRecentTurns: () => {
        assertActive();
        return structuredClone(entry.turns.slice(-10));
      },
      getAnswer: (answerId) => {
        assertActive();
        return structuredClone(entry.turns.find(turn => turn.answer.answerId === answerId)?.answer);
      },
      appendApprovedTurn: (turn) => {
        assertActive();
        if (entry.turns.length >= MAX_COMPLETED_TURNS) {
          throw new SessionError("LIMIT_EXCEEDED", 429, "대화 횟수 한도에 도달했습니다. 새 대화를 시작해 주세요.");
        }
        if (entry.turns.some(item => item.answer.answerId === turn.answer.answerId)) {
          throw new SessionError("REQUEST_CONFLICT", 409, "이미 저장된 답변입니다.");
        }
        // Bound session memory as well as the number of completed turns.
        if (!turn.userText.trim() || turn.userText.length > 500 ||
            !turn.answer.text.trim() || turn.answer.text.length > 400 ||
            JSON.stringify(turn).length > 16_000) {
          throw new SessionError("INVALID_INPUT", 400, "저장할 대화의 크기나 내용이 올바르지 않습니다.");
        }
        entry.turns.push(structuredClone(turn));
      },
    };
  }

  revoke(token: string | undefined): void {
    const key = this.key(token);
    const entry = this.live(key);
    if (entry && key) this.remove(key, entry);
  }

  private expired(): SessionError {
    return new SessionError("SESSION_EXPIRED", 401, "대화가 만료되었습니다. 새 대화를 시작해 주세요.");
  }
}
