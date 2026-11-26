import { ChatExperience } from "./ChatExperience";

/** #114: the existing Sejong Talk flow with a switchable real-time voice mode. */
export function RealtimePoc({ voiceConfigured = false }: { voiceConfigured?: boolean }) {
  return <ChatExperience voiceModeEnabled voiceConfigured={voiceConfigured} />;
}
