import { divRound, type Rounding } from './decimal';

function checkWeights(weights: readonly bigint[]) {
  if (weights.length === 0) throw new RangeError('At least one weight is required.');
  let sum = 0n;
  for (const weight of weights) {
    if (weight < 0n) throw new RangeError('Weights must not be negative.');
    sum += weight;
  }
  if (sum === 0n) throw new RangeError('Weights must not all be zero.');
  return sum;
}

/**
 * Splits `total` in proportion to `weights` by the largest-remainder method. The parts always
 * sum to `total`, each part differs from its exact share by less than one unit, and ties go to
 * the earlier index, so the result is deterministic.
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  const sum = checkWeights(weights);
  if (total < 0n) return allocate(-total, weights).map((part) => -part);
  const parts = weights.map((weight) => (total * weight) / sum);
  let remaining = total - parts.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((weight, index) => ({ index, remainder: (total * weight) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  for (const { index } of order) {
    if (remaining === 0n) break;
    parts[index]! += 1n;
    remaining -= 1n;
  }
  return parts;
}

/**
 * Cumulative rounding: part i is round(total·W_i/W) − round(total·W_{i−1}/W), where W_i is the
 * running weight. Every prefix sum is the correctly rounded cumulative share, so earlier parts
 * never change when later weights are known and the last part clears the total exactly. Used for
 * schedules and for releasing carrying amounts in proportion to settled currency.
 */
export function allocateCumulative(
  total: bigint,
  weights: readonly bigint[],
  mode: Rounding = 'halfAwayFromZero',
): bigint[] {
  const sum = checkWeights(weights);
  let running = 0n;
  let released = 0n;
  return weights.map((weight) => {
    running += weight;
    const cumulative = divRound(total * running, sum, mode);
    const part = cumulative - released;
    released = cumulative;
    return part;
  });
}
