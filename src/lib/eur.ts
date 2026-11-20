/**
 * Demo euro pricing. Invoices and owner limits are in EUR (demo). On testnet each payment
 * settles as a small CCD amount at a fixed demo rate so test funds last; in production the
 * invoice would be priced in a euro stablecoin (e.g. EURR, a Concordium PLT) at full value.
 *
 *   DEMO_ATOMIC_PER_EUR  CCD atomic units (1 CCD = 1,000,000) settled per 1 EUR. Default 100,
 *                        i.e. EUR 1,000 settles as 0.1 CCD on testnet.
 */
export const DEMO_CURRENCY = "EUR";
export const ATOMIC_PER_EUR = BigInt(process.env.DEMO_ATOMIC_PER_EUR || "100");

/** EUR (may have cents) → atomic units of the settlement asset. */
export function eurToAtomic(eur: number): string {
  const cents = BigInt(Math.round(eur * 100));
  return ((cents * ATOMIC_PER_EUR) / 100n).toString();
}

/** Atomic units → EUR (2 decimals). */
export function atomicToEur(atomic: string | bigint): number {
  const a = BigInt(atomic);
  return Number((a * 100n) / ATOMIC_PER_EUR) / 100;
}

export const fmtEur = (eur: number) =>
  `€${eur.toLocaleString("en-IE", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
