import "server-only";

import { getSessionStore } from "../sessions/runtime";
import { SpeechHttp } from "./http";

// POST and audio route bundles must share one process-local cache and job registry.
const processState = globalThis as typeof globalThis & { sejongSpeechHttp?: SpeechHttp };

export function getSpeechHttp(): SpeechHttp {
  return processState.sejongSpeechHttp ??= new SpeechHttp(getSessionStore());
}
