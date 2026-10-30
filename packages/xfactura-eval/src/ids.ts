/*
 * Seeded identifiers. Lists such as the worklist come in identifier order, so with random
 * identifiers two runs of the same world would show an agent the same items in different orders.
 * A recorded model conversation replays only if every request is the same, so each run gives the
 * engine (its `ids` option) and the harness's own records identifiers that are a function of the
 * run's seed and their position.
 */

const hex = (value: bigint) => value.toString(16).padStart(16, '0');

/** Version 4 UUIDs derived from `seed` and a counter: the same seed gives the same sequence. */
export function seededIds(seed: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    const text = `${seed}/${n}`;
    const high = hex(BigInt.asUintN(64, BigInt(Bun.hash.wyhash(text, 1n))));
    const low = hex(BigInt.asUintN(64, BigInt(Bun.hash.wyhash(text, 2n))));
    const variant = ((parseInt(low[0]!, 16) & 0x3) | 0x8).toString(16);
    return `${high.slice(0, 8)}-${high.slice(8, 12)}-4${high.slice(13, 16)}-${variant}${low.slice(1, 4)}-${low.slice(4, 16)}`;
  };
}
