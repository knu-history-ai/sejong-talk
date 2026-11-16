import "server-only";

import type { Answer, AnswerId } from "../../contracts";
import {
  readAzureSpeechConfig,
  requestAzureSpeech,
  type SynthesizedSpeech,
} from "./azure-request";

export interface SynthesizedApprovedAnswer extends SynthesizedSpeech {
  answerId: AnswerId;
}

export async function synthesizeApprovedAnswer(
  answer: Pick<Answer, "answerId" | "text">,
  signal?: AbortSignal,
): Promise<SynthesizedApprovedAnswer> {
  const config = readAzureSpeechConfig({
    AZURE_SPEECH_KEY: process.env.AZURE_SPEECH_KEY,
    AZURE_SPEECH_REGION: process.env.AZURE_SPEECH_REGION,
  });
  const speech = await requestAzureSpeech(answer.text, config, fetch, signal);
  return { answerId: answer.answerId, ...speech };
}
