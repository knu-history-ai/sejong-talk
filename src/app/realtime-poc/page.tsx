import { RealtimePoc } from "@/features/chat/realtime-poc";
import { notFound } from "next/navigation";

export const dynamic = "force-dynamic";

export default function RealtimePocPage() {
  if (process.env.REALTIME_POC_ENABLED !== "1") notFound();
  const voiceConfigured = Boolean(process.env.ELEVENLABS_API_KEY && /^seng_[A-Za-z0-9_-]+$/.test(process.env.ELEVENLABS_SPEECH_ENGINE_ID || ""));
  return <RealtimePoc voiceConfigured={voiceConfigured} />;
}
