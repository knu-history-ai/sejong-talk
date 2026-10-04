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
    const record: ActiveRecord = {
      operation: options.operation,
      fingerprint: options.fingerprint,
      controller,
      state: {
        requestId: options.requestId,
        operation: options.operation,
        status: "processing",
      },
      promise: Promise.resolve({} as RequestState),
    };

    const abortFromParent = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) {
      abortFromParent();
    } else {
      options.signal?.addEventListener("abort", abortFromParent, { once: true });
    }

    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    record.promise = work(controller.signal)
      .then((state) => {
        if (record.state.status === "cancelled") {
          return record.state;
        }
        record.state = state;
        return record.state;
      })
      .catch((error) => {
        if (record.state.status === "cancelled") {
          return record.state;
        }
        record.state = failedRequest(
          options.requestId,
          options.operation,
          error instanceof DOMException && error.name === "AbortError"
            ? "UPSTREAM_TIMEOUT"
            : "UNAVAILABLE",
          "요청 처리가 늦어지고 있습니다. 다시 시도해 주세요.",
          true,
        );
        return record.state;
      })
      .finally(() => {
        clearTimeout(timeout);
        options.signal?.removeEventListener("abort", abortFromParent);
      });

    this.records.set(options.requestId, record);
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

    record.state = cancelledRequest(requestId, record.operation);
    record.controller.abort();
    return record.state;
  }
}

export function fingerprintJson(value: unknown): string {
  return stableJson(value);
}
