/**
 * npm run remote — open the owner dashboard on your phone through a private HTTPS link.
 *
 * Starts a Cloudflare quick tunnel (free, no account) to the dashboard on this computer and prints
 * the link + a QR code. The dashboard and the ProcureBot key stay on this computer; the tunnel only
 * forwards requests. Requires DASHBOARD_PASSWORD (12+ characters) so the link always asks to sign in.
 * The link changes every time; press Ctrl+C to close it.
 *
 * Needs cloudflared:  winget install --id Cloudflare.cloudflared   (Windows)
 */
import { spawn } from "node:child_process";
import QRCode from "qrcode";
import "dotenv/config";

const PORT = Number(process.env.WEB_PORT || 4030);
const pw = process.env.DASHBOARD_PASSWORD || "";
if (pw.length < 12) {
  console.error(`✗ Set a strong DASHBOARD_PASSWORD (12+ characters) in .env first, then restart the dashboard (npm run web).
  It protects the link: anyone with the link must sign in before seeing anything.`);
  process.exit(1);
}

// The dashboard must be running AND have the login on (otherwise it would refuse tunnel requests anyway).
try {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/session`, { signal: AbortSignal.timeout(5000) });
  if (r.status !== 401) {
    console.error("✗ The dashboard is running without the login. Restart it (Ctrl+C, then npm run web) so it picks up DASHBOARD_PASSWORD.");
    process.exit(1);
  }
} catch {
  console.error(`✗ The dashboard isn't running on port ${PORT}. Start it first: npm run web`);
  process.exit(1);
}

console.log("Opening a private link to your dashboard…");
const cf = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
cf.on("error", () => {
  console.error(`✗ cloudflared isn't installed. On Windows run:
    winget install --id Cloudflare.cloudflared
  then close and reopen PowerShell, and run npm run remote again.`);
  process.exit(1);
});
let shown = false;
const recent: string[] = [];
const onData = async (buf: Buffer) => {
  const text = buf.toString();
  recent.push(...text.split("\n").filter((l) => /ERR|error|failed/i.test(l)).map((l) => l.trim()));
  recent.splice(0, Math.max(0, recent.length - 5));
  // the tunnel's own address (never api.trycloudflare.com, which only appears in cloudflared's logs)
  const m = text.match(/https:\/\/(?!api\.)[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/);
  if (!m || shown) return;
  shown = true;
  console.log("\n✓ Your private dashboard link (sign in with DASHBOARD_PASSWORD):\n\n   " + m[0] + "\n");
  console.log(await QRCode.toString(m[0], { type: "terminal", small: true }));
  console.log("Scan the QR code with your phone's camera. Keep this window open; Ctrl+C closes the link.");
  console.log("Don't share the link publicly. Wrong passwords are locked out and recorded in the audit log.\n");
};
cf.stdout.on("data", onData);
cf.stderr.on("data", onData);
cf.on("exit", (code) => {
  if (!shown) console.error(`✗ Couldn't open the link. cloudflared said:\n  ${recent.join("\n  ") || "(no details)"}\n  Check your internet connection and try again.`);
  else console.log(`Link closed${code ? ` (cloudflared exited with ${code})` : ""}.`);
  process.exit(code ?? 0);
});
process.on("SIGINT", () => cf.kill());
