/** W01-08 wire/data contracts. Types do not validate untrusted runtime input. */
export type CharacterId = string;
export type RequestId = string;
export type AnswerId = string;
export type SessionId = string;
export type ISODateTime = string;

export interface SourceView {
  id: string;
  title: string;
  institution: string;
  url: string;
}
export interface Source extends SourceView {
  locator: string;
  checkedAt: ISODateTime | null;
}
export interface Character {
  id: CharacterId;
  name: string;
  intro: string;
  personaVersion: string;
  policyVersion: string;
}
export interface Fact {
  id: string;
  characterId: CharacterId;
  topic: string;
  text: string;
  sourceIds: string[];
  reviewStatus: "pending" | "approved" | "rejected";
}
export interface PromptExample {
  characterId: CharacterId;
  question: string;
  desiredBehavior: string;
}
export interface EvalCase {
  id: string;
  characterId: CharacterId;
  category: "fact" | "uncertainty" | "conversation" | "injection" | "overblocking";
  input: string;
  expectedFacts: string[];
  failureConditions: string[];
}
export interface EvalResult {
  caseId: string;
  runId: string;
  model: string;
  personaVersion: string;
  contentVersion: string;
  evaluatedAt: ISODateTime;
  verdict: "pass" | "fail" | "needs_review";
  notes: string;
}

export interface Answer {
  answerId: AnswerId;
  kind: "grounded" | "conversation" | "insufficient" | "fallback";
  text: string;
  factIds: string[];
  sources: SourceView[];
  personaVersion: string;
  contentVersion: string;
}

export type ErrorCode =
  | "INVALID_INPUT" | "AUDIO_UNSUPPORTED" | "SESSION_EXPIRED"
  | "FORBIDDEN" | "REQUEST_NOT_FOUND" | "REQUEST_CONFLICT"
  | "LIMIT_EXCEEDED" | "UPSTREAM_TIMEOUT" | "UNAVAILABLE";
export interface ApiError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  /** null only when no valid request ID was received (e.g. session creation). */
  requestId: RequestId | null;
  retryAfterSeconds?: number;
}
export interface ErrorResponse extends ApiError { status: "failed" }

export interface CreateSessionRequest { characterId: CharacterId }
export interface CreateSessionResponse {
  status: "created";
  sessionId: SessionId;
  characterId: CharacterId;
  expiresAt: ISODateTime;
  intro: string;
  suggestedQuestions: string[];
}
export interface DeleteSessionResponse { status: "deleted" }
export interface TurnRequest { requestId: RequestId; text: string }
/** Multipart/form-data fields, not a JSON body. */
export interface TranscriptionRequest { requestId: RequestId; audio: Blob }
/** The server retrieves approved text by answerId; clients never submit TTS text. */
export interface SpeechRequest { requestId: RequestId; answerId: AnswerId }

export type Operation = "turn" | "transcription" | "speech";
export interface PendingResponse<O extends Operation = Operation> {
  requestId: RequestId;
  operation: O;
  status: "queued" | "processing";
}
export interface CancelledResponse<O extends Operation = Operation> {
  requestId: RequestId;
  operation: O;
  status: "cancelled";
}
export interface ApprovedTurn {
  requestId: RequestId;
  operation: "turn";
  status: "approved";
  answer: Answer;
}
export interface CompletedTranscription {
  requestId: RequestId;
  operation: "transcription";
  status: "completed";
  text: string;
}
export interface CompletedSpeech {
  requestId: RequestId;
  operation: "speech";
  status: "completed";
  answerId: AnswerId;
  /** Authenticated same-origin URL; expires with this session. */
  audio: { url: string; mimeType: string; expiresAt: ISODateTime };
}
export interface FailedRequest extends ApiError {
  requestId: RequestId;
  operation: Operation;
  status: "failed";
}
export type RequestState = PendingResponse | CancelledResponse | ApprovedTurn
  | CompletedTranscription | CompletedSpeech | FailedRequest;
export type TurnResponse = PendingResponse<"turn"> | CancelledResponse<"turn"> | ApprovedTurn | ErrorResponse;
export type TranscriptionResponse = PendingResponse<"transcription"> | CancelledResponse<"transcription"> | CompletedTranscription | ErrorResponse;
export type SpeechResponse = PendingResponse<"speech"> | CancelledResponse<"speech"> | CompletedSpeech | ErrorResponse;
export type RequestResponse = RequestState | ErrorResponse;
