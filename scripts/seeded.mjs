// Deterministic choices for model tests. Include the seed in each test name
// and the event trace on failure so one scenario can be replayed with node.
export function seeded(seed) {
  return (limit) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return Math.floor(seed / 0x100000000 * limit)
  }
}
