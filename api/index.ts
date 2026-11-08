/**
 * Vercel entry: one deployment serves the TenderScout seller agent at / and the
 * Cord sponsoring facilitator at /facilitator. Set FACILITATOR_URL to
 * https://<your-domain>/facilitator in the Vercel project env.
 */
import express from "express";
import { app as facilitator } from "../src/facilitator/server.js";
import { app as seller } from "../src/seller/server.js";

const root = express();
root.use("/facilitator", facilitator);
root.use(seller);
export default root;
