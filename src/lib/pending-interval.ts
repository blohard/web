/** Quick initial receipt checks, then bounded backoff for a pending transaction. */
export const pendingInterval = (pendingAnswers: number) =>
  pendingAnswers <= 3 ? 2_000 : Math.min(15_000, Math.round(2_000 * 1.5 ** (pendingAnswers - 3)))
