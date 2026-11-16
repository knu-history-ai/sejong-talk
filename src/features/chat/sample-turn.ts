import type { TurnRequest, TurnResponse } from "@/contracts";

const answers: Record<string, string> = {
  "한글은 왜 만들었나요?": "백성들이 자신의 생각을 글로 쉽게 표현할 수 있기를 바랐단다. 그래서 누구나 배우기 쉬운 새 글자를 만들었지.",
  "백성을 위해 어떤 일을 했나요?": "백성의 생활에 도움이 되는 일을 중요하게 여겼단다. 농사와 글자, 과학처럼 삶과 가까운 문제를 살피려 노력했지.",
  "장영실은 어떤 사람인가요?": "장영실은 조선의 과학 기술 발전에 힘쓴 인물이란다. 시간을 재고 날씨를 살피는 여러 기구를 만드는 데 참여했지.",
};

/** UI development only. Replace this transport after session/API integration. */
export function requestSampleTurn(
  request: TurnRequest,
  { signal, fail = false }: { signal: AbortSignal; fail?: boolean },
): Promise<TurnResponse> {
  return new Promise((resolve) => {
    const cancelled = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancelled);
      resolve({ requestId: request.requestId, operation: "turn", status: "cancelled" });
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancelled);
      if (fail) {
        resolve({ requestId: request.requestId, status: "failed", code: "UNAVAILABLE", message: "지금은 답변을 가져오지 못했어요. 잠시 후 다시 시도하거나 질문을 바꿔서 물어보세요.", retryable: true });
        return;
      }
      resolve({
        requestId: request.requestId, operation: "turn", status: "approved",
        answer: {
          answerId: `sample-${request.requestId}`, kind: "conversation",
          text: answers[request.text] ?? "좋은 질문이구나. 실제 서비스에서는 검토된 역사 자료를 바탕으로 질문에 맞는 답변이 이곳에 나타난단다.",
          factIds: [], sources: [], personaVersion: "sample", contentVersion: "sample",
        },
      });
    }, 850);
    if (signal.aborted) cancelled();
    else signal.addEventListener("abort", cancelled, { once: true });
  });
}
