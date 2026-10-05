import { notFound } from "next/navigation";
import { VoiceInputDemo } from "@/features/voice-input/voice-input-demo";

export default function VoiceInputTestPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <VoiceInputDemo />;
}
