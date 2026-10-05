import type {
  ApprovedTurn,
  FailedRequest,
  Operation,
  RequestId,
  RequestState,
  TurnRequest,
} from "../../contracts";
import type { RecentApprovedTurn } from "./prompt";

export interface RequestCoordinatorLike {
  run<T extends RequestState>(
    options: {
      requestId: RequestId;
      operation: Operation;
      fingerprint: string;
      timeoutMs: number;
      signal?: AbortSignal;
    },
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<RequestState>;
}

export interface GenerateSejongTurnOptions {
  request: TurnRequest;
  recentConversation?: RecentApprovedTurn[];
  signal?: AbortSignal;
}

export interface RunCoordinatedSejongTurnOptions
  extends GenerateSejongTurnOptions {
  coordinator: RequestCoordinatorLike;
  generateTurn: (
    options: GenerateSejongTurnOptions,
  ) => Promise<ApprovedTurn | FailedRequest>;
  timeoutMs?: number;
  isSessionActive?: () => boolean | Promise<boolean>;
  onApprovedTurn?: (turn: ApprovedTurn) => void | Promise<void>;
}

function sessionExpiredTurn(requestId: string): FailedRequest {
  return {
    requestId,
    operation: "turn",
    status: "failed",
    code: "SESSION_EXPIRED",
    message: "대화 세션이 만료되었습니다. 새 대화를 시작해 주세요.",
    retryable: false,
  };
}

function cancelledTurn(requestId: string): RequestState {
  return { requestId, operation: "turn", status: "cancelled" };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

async function isActive(
  check: RunCoordinatedSejongTurnOptions["isSessionActive"],
): Promise<boolean> {
  return check ? Boolean(await check()) : true;
}

export function buildSejongTurnFingerprint({
  request,
  recentConversation = [],
}: Pick<RunCoordinatedSejongTurnOptions, "request" | "recentConversation">): string {
  return stableJson({
    operation: "turn",
    request,
    recentConversation,
  });
}

export async function runCoordinatedSejongTurn({
  coordinator,
  generateTurn,
  request,
  recentConversation = [],
  signal,
  timeoutMs = 20_000,
  isSessionActive,
  onApprovedTurn,
}: RunCoordinatedSejongTurnOptions): Promise<RequestState> {
  if (!(await isActive(isSessionActive))) {
    return sessionExpiredTurn(request.requestId);
  }

  return coordinator.run(
    {
      requestId: request.requestId,
      operation: "turn",
      fingerprint: buildSejongTurnFingerprint({ request, recentConversation }),
      timeoutMs,
      signal,
    },
    async (coordinatorSignal) => {
      if (coordinatorSignal.aborted) return cancelledTurn(request.requestId);
      if (!(await isActive(isSessionActive))) {
        return sessionExpiredTurn(request.requestId);
      }
      if (coordinatorSignal.aborted) return cancelledTurn(request.requestId);

      const turn = await generateTurn({
        request,
        recentConversation,
        signal: coordinatorSignal,
      });

      if (coordinatorSignal.aborted) return cancelledTurn(request.requestId);
      if (turn.status !== "approved") {
        return turn;
      }

      if (!(await isActive(isSessionActive)) || coordinatorSignal.aborted) {
        return cancelledTurn(request.requestId);
      }

      await onApprovedTurn?.(turn);
      return turn;
    },
  );
}
