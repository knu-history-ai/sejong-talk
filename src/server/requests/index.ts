import type {
  FailedRequest,
  Operation,
  RequestId,
  RequestState,
} from "../../contracts";

export interface RequestWorkOptions {
  requestId: RequestId;
  operation: Operation;
  fingerprint: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

type RequestWork<T extends RequestState> = (signal: AbortSignal) => Promise<T>;

interface ActiveRecord {
  operation: Operation;
  fingerprint: string;
  controller: AbortController;
  promise: Promise<RequestState>;
  state: RequestState;
  settle: (state: RequestState) => void;
}

function failedRequest(
  requestId: RequestId,
  operation: Operation,
  code: FailedRequest["code"],
  message: string,
  retryable: boolean,
): FailedRequest {
  return {
    requestId,
    operation,
    status: "failed",
    code,
    message,
    retryable,
  };
}

function cancelledRequest(
  requestId: RequestId,
  operation: Operation,
): RequestState {
  return { requestId, operation, status: "cancelled" };
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

export class RequestCoordinator {
  private readonly records = new Map<RequestId, ActiveRecord>();

  get(requestId: RequestId): RequestState | null {
    return this.records.get(requestId)?.state ?? null;
  }

  async run<T extends RequestState>(
    options: RequestWorkOptions,
    work: RequestWork<T>,
  ): Promise<RequestState> {
    const existing = this.records.get(options.requestId);
    if (existing) {
      if (
        existing.operation !== options.operation ||
        existing.fingerprint !== options.fingerprint
      ) {
        return failedRequest(
          options.requestId,
          options.operation,
          "REQUEST_CONFLICT",
          "같은 요청 ID로 다른 작업을 처리할 수 없습니다.",
          false,
        );
      }

      return existing.promise;
    }

    const controller = new AbortController();
    let resolveResult!: (state: RequestState) => void;
    const record: ActiveRecord = {
      operation: options.operation,
      fingerprint: options.fingerprint,
      controller,
      state: {
        requestId: options.requestId,
        operation: options.operation,
        status: "processing",
      },
      promise: new Promise((resolve) => { resolveResult = resolve; }),
      settle: () => {},
    };
    let settled = false;
    const abortFromParent = () => {
      record.settle(cancelledRequest(options.requestId, options.operation));
      controller.abort(options.signal?.reason);
    };
    record.settle = (state) => {
      if (settled) return;
      settled = true;
      record.state = state;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortFromParent);
      resolveResult(state);
    };
    this.records.set(options.requestId, record);

    const timeout = setTimeout(() => {
      record.settle(failedRequest(
        options.requestId, options.operation, "UPSTREAM_TIMEOUT",
        "요청 처리가 늦어지고 있습니다. 다시 시도해 주세요.", true,
      ));
      controller.abort();
    }, options.timeoutMs);

    if (options.signal?.aborted) {
      abortFromParent();
      return record.promise;
    }
    options.signal?.addEventListener("abort", abortFromParent, { once: true });

    const handleFailure = (error: unknown) => {
      record.settle(failedRequest(
          options.requestId,
          options.operation,
          error instanceof DOMException && error.name === "AbortError"
            ? "UPSTREAM_TIMEOUT"
            : "UNAVAILABLE",
          "요청 처리가 늦어지고 있습니다. 다시 시도해 주세요.",
          true,
      ));
    };
    // A provider may ignore abort. Settle independently and never accept its late result.
    try {
      void work(controller.signal).then(record.settle).catch(handleFailure);
    } catch (error) {
      handleFailure(error);
    }
    return record.promise;
  }

  cancel(requestId: RequestId): RequestState | null {
    const record = this.records.get(requestId);
    if (!record) {
      return null;
    }

    if (
      record.state.status === "approved" ||
      record.state.status === "completed" ||
      record.state.status === "failed"
    ) {
      return record.state;
    }

    record.settle(cancelledRequest(requestId, record.operation));
    record.controller.abort();
    return record.state;
  }
}

export function fingerprintJson(value: unknown): string {
  return stableJson(value);
}
