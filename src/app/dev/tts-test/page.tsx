import { notFound } from "next/navigation";
import { VoiceOutputDemo } from "@/features/voice-output/voice-output-demo";

export default function TtsTestPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <VoiceOutputDemo />;
}
