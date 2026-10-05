import { notFound } from "next/navigation";
import { SttComparison } from "@/features/voice-input/stt-comparison";
export default function SttTestPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <SttComparison />;
}
