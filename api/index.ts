/**
 * Vercel entry: one deployment serves the TenderScout seller agent at / and the
 * Cord sponsoring facilitator at /facilitator. Until the Concordium testnet accounts are
 * set in the project's env vars (see .env.example), it answers 503 with setup info.
 */
import express from "express";

const root = express();
try {
  const { app: facilitator } = await import("../src/facilitator/server.js");
  const { app: seller } = await import("../src/seller/server.js");
  root.use("/facilitator", facilitator);
  root.use(seller);
} catch (e) {
  root.use((_req, res) =>
    res.status(503).json({
      service: "Cord (TenderScout seller + sponsoring facilitator)",
      status: "not configured",
      error: (e as Error).message,
      setup: "Set CCD_FACILITATOR_ADDRESS, CCD_FACILITATOR_PRIVATE_KEY and SELLER_PAY_TO in Vercel env vars, then redeploy.",
      repo: "https://github.com/grahamaine/cord-dapp",
    }),
  );
}
export default root;
