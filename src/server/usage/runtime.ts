import "server-only";
import { resolve } from "node:path";
import { UsageError, UsageLedger, type CallOptions, type UsagePolicy, type UsageUnits } from "./ledger.ts";

export function readUsagePolicy(env: NodeJS.ProcessEnv = process.env): UsagePolicy {
  let plans;
  try { plans = JSON.parse(env.USAGE_PROVIDER_PLANS || "{}"); }
  catch { throw new UsageError("UNAVAILABLE"); }
  if (!plans || Array.isArray(plans) || typeof plans !== "object") throw new UsageError("UNAVAILABLE");
  const integer = (key: string, fallback: number) => env[key] === undefined || env[key] === "" ? fallback : Number(env[key]);
  return {
    // Mentor policy: students do not register cards or enable paid services.
    // No environment variable can turn paid calls on in this version.
    allowPaid: false, plans,
    dailyBudgetMicros: integer("USAGE_DAILY_BUDGET_MICROS", 0),
    monthlyBudgetMicros: integer("USAGE_MONTHLY_BUDGET_MICROS", 0),
    maxConcurrent: integer("USAGE_MAX_CONCURRENT", 5),
    callsPerMinute: integer("USAGE_CALLS_PER_MINUTE", 60),
    sessionPerMinute: integer("USAGE_SESSION_PER_MINUTE", 6),
    maxCompletedTurns: integer("USAGE_COMPLETED_TURNS", 30),
  };
}
const state = globalThis as typeof globalThis & { sejongUsageLedger?: UsageLedger };
export function getUsageLedger(): UsageLedger {
  try { return state.sejongUsageLedger ??= new UsageLedger(resolve(/* turbopackIgnore: true */ process.env.USAGE_DB_PATH || "private/usage/ledger.sqlite"), readUsagePolicy()); }
  catch { throw new UsageError("UNAVAILABLE"); }
}
export async function runMeteredCall<T>(
  options: CallOptions,
  work: (report: (units: Partial<UsageUnits>) => void) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const ledger = getUsageLedger(); const id = ledger.reserve(options);
  let units: UsageUnits = {};
  try {
    signal?.throwIfAborted();
    const result = await work((reported) => { units = { ...units, ...reported }; });
    signal?.throwIfAborted();
    ledger.finish(id, "completed", units);
    return result;
  } catch (error) {
    // Keep the ceiling for uncertain failed/cancelled calls: abort does not prove no billing.
    ledger.finish(id, signal?.aborted ? "cancelled" : "failed", units);
    throw error;
  }
}
