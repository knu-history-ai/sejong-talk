import { notFound } from "next/navigation";
import { RealtimeVoiceTest } from "@/features/realtime-voice/realtime-voice-test";

export const dynamic = "force-dynamic";

/** 실시간 음성 PoC 시험 화면. REALTIME_POC_ENABLED=1 일 때만 열린다. */
export default function RealtimeVoiceTestPage() {
  if (process.env.REALTIME_POC_ENABLED !== "1") notFound();
  return <RealtimeVoiceTest />;
}
