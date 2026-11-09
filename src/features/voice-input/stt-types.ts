export const PROVIDERS = ["azure", "clova", "deepgram", "groq", "elevenlabs"] as const;
export type SttProvider = typeof PROVIDERS[number];
export type SttResult = { provider: SttProvider; text: string; latencyMs: number; success: boolean; error?: string };
export const TEST_SENTENCES = [
  "세종대왕은 왜 훈민정음을 만들었나요?", "훈민정음은 처음에 몇 글자였어요?",
  "집현전에서는 어떤 일을 했나요?", "세종대왕과 장영실은 어떤 관계였나요?",
  "측우기는 누가 만들었나요?", "자격루는 어떤 기계인가요?",
  "훈민정음 해례본은 무엇인가요?", "세종 때 과학 기술은 어떻게 발전했나요?",
  "장영실이 만든 과학 기구에는 무엇이 있었나요?", "세종대왕은 백성을 위해 어떤 정책을 펼쳤나요?",
];
