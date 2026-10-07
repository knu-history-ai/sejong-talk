// Explicit dependency for tests with mocked provider fetches. It does not open
// the real usage ledger or infer an account's billing plan from test mode.
export async function mockMeteredCall(_options, work, signal) {
  signal?.throwIfAborted();
  const result = await work(() => {});
  signal?.throwIfAborted();
  return result;
}
