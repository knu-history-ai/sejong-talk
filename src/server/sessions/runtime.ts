import "server-only";
import { SessionStore } from "./store.ts";

// Route bundles and development hot reload must use the same process-local store.
// This is deliberately NOT durable storage or a multi-instance deployment solution.
const processState = globalThis as typeof globalThis & {
  sejongSessionStore?: SessionStore;
};
export function getSessionStore(): SessionStore {
  return processState.sejongSessionStore ??= new SessionStore();
}
