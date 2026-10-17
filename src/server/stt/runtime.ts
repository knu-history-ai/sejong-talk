import "server-only";

import { getSessionStore } from "../sessions/runtime";
import { TranscriptionHttp } from "./session-http";

// Share one job registry across route bundles and development hot reloads.
const processState = globalThis as typeof globalThis & { sejongTranscriptionHttp?: TranscriptionHttp };

export function getTranscriptionHttp(): TranscriptionHttp {
  return processState.sejongTranscriptionHttp ??= new TranscriptionHttp(getSessionStore());
}
