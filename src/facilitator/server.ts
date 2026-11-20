/**
 * Cord facilitator: verifies x402 payments on Concordium and SPONSORS them.
 * Buyers sign a V1 sponsored transaction naming this account as sponsor; we check the
 * 9 security rules, add the sponsor signature, submit, and wait for finality (~10s).
 * Result: agents pay each other in CCD or a PLT stablecoin without ever holding CCD for fees.
 */
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactConcordiumScheme } from "@x402/concordium/exact/facilitator";
import { toConcordiumFacilitatorSigner, getExplorerTxUrl } from "@x402/concordium";
import { config } from "../lib/config.js";

const signer = toConcordiumFacilitatorSigner(config.facilitator.address(), config.facilitator.privateKey(), {
  host: config.grpc.host,
  port: config.grpc.port,
  useTls: true,
});

const facilitator = new x402Facilitator().register(
  config.network,
  new ExactConcordiumScheme({ signer, requireFinalization: true }),
);

export const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/supported", (_req, res) => res.json(facilitator.getSupported()));

app.post("/verify", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    res.json(await facilitator.verify(paymentPayload, paymentRequirements));
  } catch (e) {
    res.status(400).json({ isValid: false, invalidReason: String((e as Error).message) });
  }
});

app.post("/settle", async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    if (result.success) {
      console.log(`[facilitator] sponsored + settled ${paymentRequirements.amount} ${paymentRequirements.asset} -> ${paymentRequirements.payTo}`);
      console.log(`              ${getExplorerTxUrl(config.network, result.transaction) ?? result.transaction}`);
    } else {
      console.warn("[facilitator] settle failed:", result.errorReason);
    }
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, errorReason: String((e as Error).message) });
  }
});

app.get("/healthz", (_req, res) => res.json({ ok: true, sponsor: config.facilitator.address(), network: config.network }));

if (!process.env.VERCEL) app.listen(config.facilitator.port, () =>
  console.log(`Kakasa facilitator on :${config.facilitator.port} (sponsor ${config.facilitator.address()}, ${config.network})`),
);
