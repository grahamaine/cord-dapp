/**
 * Euro pricing and settlement assets. Invoices and owner limits are always in EUR; what moves
 * on-chain depends on the settlement asset of each payment:
 *
 *   CCD   demo mode. Each EUR settles as a small CCD amount at a fixed rate so test funds last.
 *         DEMO_ATOMIC_PER_EUR = CCD atomic units (1 CCD = 1,000,000) per 1 EUR. Default 100,
 *         i.e. EUR 1,000 settles as 0.1 CCD.
 *   PLT   stablecoin mode (EURR, USDR or any Protocol-Level Token). Invoices settle at FULL value:
 *         EUR 1,850 = 1,850 EURR. Decimals and the EUR value of one token come from env:
 *           INVOICE_ASSET            asset invoices settle in (default: PRICE_ASSET, else CCD)
 *           INVOICE_ASSET_DECIMALS   decimals of INVOICE_ASSET (default 6; `npm run doctor` checks it on-chain)
 *           ASSET_EUR_<SYMBOL>       EUR value of one whole token, e.g. ASSET_EUR_USDR=0.86
 *         Tokens whose symbol starts with "EUR" default to 1 EUR per token. Any other PLT without a
 *         rate is refused by the owner's policy, so the agent never guesses an exchange rate.
 */
import "dotenv/config";

export const DEMO_CURRENCY = "EUR";
export const ATOMIC_PER_EUR = BigInt(process.env.DEMO_ATOMIC_PER_EUR || "100");
export const INVOICE_ASSET = (process.env.INVOICE_ASSET || process.env.PRICE_ASSET || "CCD").trim();

export const isCcd = (asset: string) => asset.toUpperCase() === "CCD";

export interface AssetSpec {
  asset: string;
  decimals: number;
  /** EUR value of one whole token; null if unknown (payments in it are refused). */
  eurPerToken: number | null;
  /** true for CCD: amounts are a fixed demo fraction of the EUR value, not full value. */
  demo: boolean;
}

export function assetSpec(asset: string): AssetSpec {
  const sym = asset.toUpperCase();
  if (isCcd(asset)) return { asset: "CCD", decimals: 6, eurPerToken: null, demo: true };
  const decimals = Number(
    process.env[`ASSET_DECIMALS_${sym}`] || (sym === INVOICE_ASSET.toUpperCase() ? process.env.INVOICE_ASSET_DECIMALS : "") || 6,
  );
  const rateEnv = process.env[`ASSET_EUR_${sym}`];
  // EURC (Base / Solana testnet settlement) defaults to a demo scale: 1 EURC = EUR 1,000, so the
  // faucet's 10 EURC a day covers several invoices. Set ASSET_EUR_EURC=1 for full value.
  const eurPerToken = rateEnv ? Number(rateEnv) : sym === "EURC" ? 1000 : sym.startsWith("EUR") ? 1 : null;
  return { asset, decimals, eurPerToken: eurPerToken && eurPerToken > 0 ? eurPerToken : null, demo: false };
}

/** Why an asset can't be priced in EUR, or undefined if it can. */
export function unpriceable(asset: string): string | undefined {
  const s = assetSpec(asset);
  if (!s.demo && s.eurPerToken === null) return `no EUR rate set for ${asset} (set ASSET_EUR_${asset.toUpperCase()} in .env)`;
  return undefined;
}

/** EUR (may have cents) → atomic units of `asset`. */
export function eurToAtomic(eur: number, asset = INVOICE_ASSET): string {
  const cents = BigInt(Math.round(eur * 100));
  const s = assetSpec(asset);
  if (s.demo) return ((cents * ATOMIC_PER_EUR) / 100n).toString();
  if (s.eurPerToken === null) throw new Error(unpriceable(asset));
  if (s.eurPerToken === 1) {
    return s.decimals >= 2 ? (cents * 10n ** BigInt(s.decimals - 2)).toString() : (cents / 10n ** BigInt(2 - s.decimals)).toString();
  }
  return BigInt(Math.round((eur / s.eurPerToken) * 10 ** s.decimals)).toString();
}

/** Atomic units of `asset` → EUR (2 decimals). NaN if the asset has no EUR rate. Old receipts without an asset are CCD. */
export function atomicToEur(atomic: string | bigint, asset = "CCD"): number {
  const a = BigInt(atomic);
  const s = assetSpec(asset);
  if (s.demo) return Number((a * 100n) / ATOMIC_PER_EUR) / 100;
  if (s.eurPerToken === null) return NaN;
  const whole = Number(a) / 10 ** s.decimals;
  return Math.round(whole * s.eurPerToken * 100) / 100;
}

/** Atomic units → "1,850 EURR" / "0.185 CCD". */
export function fmtAtomic(atomic: string | bigint, asset: string): string {
  const { decimals } = assetSpec(asset);
  const n = BigInt(atomic), d = 10n ** BigInt(decimals);
  const frac = decimals ? (n % d).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return `${(n / d).toLocaleString("en-IE")}${frac ? "." + frac : ""} ${asset}`;
}

/** What the dashboards need to show amounts correctly. */
export function settlementInfo() {
  const s = assetSpec(INVOICE_ASSET);
  return {
    invoiceAsset: INVOICE_ASSET,
    decimals: s.decimals,
    fullValue: !s.demo,
    eurPerToken: s.eurPerToken,
    atomicPerEur: ATOMIC_PER_EUR.toString(),
    rateMissing: unpriceable(INVOICE_ASSET) ?? null,
  };
}

export const fmtEur = (eur: number) =>
  `€${eur.toLocaleString("en-IE", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
