/**
 * Time budgets for performance tests. Shared CI machines (GitHub Actions sets CI=true) are slower and noisier than a
 * developer machine, so a budget gets a 4× margin there: the tests still catch order-of-magnitude regressions without
 * failing a deploy on a busy runner.
 */
const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;

export const ON_CI = Boolean(env?.CI);

/** The time budget in milliseconds for this machine. */
export function perfBudgetMs(ms: number): number {
  return ON_CI ? ms * 4 : ms;
}
