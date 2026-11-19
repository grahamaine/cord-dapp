/**
 * Vercel entry. Serves the TenderScout seller agent (and both public Agent Cards) at /,
 * and the Cord sponsoring facilitator at /facilitator when its keys are configured.
 * The seller needs only SELLER_PAY_TO (a public address), so the cards stay online even
 * when no private key is stored on Vercel.
 */
import express from "express";

const root = express();
const notConfigured = (service: string, e: unknown, setup: string) => (_req: express.Request, res: express.Response) =>
  res.status(503).json({ service, status: "not configured", error: (e as Error).message, setup, repo: "https://github.com/grahamaine/cord-dapp" });

try {
  const { app: facilitator } = await import("../src/facilitator/server.js");
  root.use("/facilitator", facilitator);
} catch (e) {
  root.use("/facilitator", notConfigured("Cord facilitator", e, "Set CCD_FACILITATOR_ADDRESS and CCD_FACILITATOR_PRIVATE_KEY in Vercel env vars, then redeploy."));
}

try {
  const { app: seller } = await import("../src/seller/server.js");
  root.use(seller);
} catch (e) {
  root.use(notConfigured("TenderScout seller", e, "Set SELLER_PAY_TO in Vercel env vars, then redeploy."));
}

export default root;
