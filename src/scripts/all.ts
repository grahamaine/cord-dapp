/**
 * npm run all — start Kakasa with one command instead of three windows.
 *
 * Starts, in order, the facilitator (:4020), the TenderScout seller (:4021) and the owner dashboard (:4030),
 * waits for each to answer, then opens the AI agent in your browser. Output from all three is shown here,
 * labelled. Ctrl+C stops everything.
 *
 *   npm run all                 start everything and open http://localhost:4030/#agent
 *   npm run all -- --remote     also open the private HTTPS link + QR code (phone or judges; needs DASHBOARD_PASSWORD)
 *   npm run all -- --doctor     run the key/balance checks first
 *   npm run all -- --no-open    don't open the browser
 *
 * Windows PowerShell: use npm.cmd, e.g.  npm.cmd run all -- --remote
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import "dotenv/config";

const args = new Set(process.argv.slice(2));
const remote = args.has("--remote");
const openBrowser = !args.has("--no-open");
const doctor = args.has("--doctor");

// Run each service directly in Node with the tsx loader (one process per service). Going through the tsx
// command-line launcher adds a second process per service, which on Windows hid all output and the port.
const nodeArgs = (file: string) => ["--import", "tsx", file];

const WEB_PORT = Number(process.env.WEB_PORT || 4030);
const FACILITATOR_URL = process.env.FACILITATOR_URL || `http://localhost:${process.env.FACILITATOR_PORT || 4020}`;
const SELLER_URL = process.env.SELLER_URL || `http://localhost:${process.env.SELLER_PORT || 4021}`;
const WEB_URL = `http://localhost:${WEB_PORT}`;

const COLORS: Record<string, string> = { facilitator: "\x1b[36m", seller: "\x1b[35m", web: "\x1b[32m", remote: "\x1b[33m" };
const RESET = "\x1b[0m";
const children = new Map<string, ChildProcess>();
const listening = new Set<string>(); // services that printed their "on :port" line
let stopping = false;

function label(name: string) {
  return `${COLORS[name] ?? ""}[${name.padEnd(11)}]${RESET}`;
}

function start(name: string, file: string, { critical = true } = {}) {
  const child = spawn(process.execPath, nodeArgs(file), { stdio: ["ignore", "pipe", "pipe"], env: process.env, windowsHide: true });
  children.set(name, child);
  const pipe = (buf: Buffer) => {
    for (const line of buf.toString().split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/ on (:\d+|https?:\/\/)/.test(line)) listening.add(name);
      console.log(`${label(name)} ${line}`);
    }
  };
  child.stdout!.on("data", pipe);
  child.stderr!.on("data", pipe);
  child.on("exit", (code) => {
    children.delete(name);
    if (stopping) return;
    if (critical) {
      console.error(`\n✗ ${name} stopped (exit code ${code}). Stopping the others. Check the lines above for the reason.`);
      stopAll(code || 1);
    } else console.log(`${label(name)} closed${code ? ` (exit code ${code})` : ""}. The rest keep running.`);
  });
  return child;
}

/**
 * Wait until a service is ready: its health URL answers (any HTTP status counts: 401 means the login is on),
 * or, failing that, it has printed its "on :port" line and 15 more seconds have passed. In that second case
 * the others still start, with a warning, so one slow health check doesn't stop everything.
 */
async function waitFor(name: string, url: string, timeoutMs = 240_000) {
  const urls = [url.replace("//localhost:", "//127.0.0.1:"), url]; // IPv4 first, then as configured
  const until = Date.now() + timeoutMs;
  let listeningSince = 0;
  const started = Date.now();
  let nextNote = started + 20_000;
  while (Date.now() < until) {
    if (Date.now() > nextNote && !listening.has(name)) {
      console.log(`${label(name)} still starting… (${Math.round((Date.now() - started) / 1000)} s; the first start on a slower PC can take a couple of minutes)`);
      nextNote += 20_000;
    }
    if (!children.has(name)) return false;
    for (const u of urls) {
      try {
        await fetch(u, { signal: AbortSignal.timeout(5000) });
        return true;
      } catch { /* try the next one */ }
    }
    if (listening.has(name)) {
      listeningSince ||= Date.now();
      if (Date.now() - listeningSince > 15_000) {
        console.log(`${label(name)} ! started, but ${url} didn't answer yet. Carrying on; if it stays unreachable,`);
        console.log(`${label(name)}   check nothing else is using its port (Windows: netstat -ano | findstr :${new URL(url).port}).`);
        return true;
      }
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  // Still running but never confirmed: carry on with a warning rather than stopping everything.
  if (children.has(name)) {
    console.log(`${label(name)} ! no answer after ${timeoutMs / 1000} s but still running. Carrying on; if it stays unreachable, try: npm run ${name}`);
    return true;
  }
  return false;
}

function stopAll(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const c of children.values()) c.kill();
  setTimeout(() => process.exit(code), 800);
}
process.on("SIGINT", () => { console.log("\nStopping Kakasa…"); stopAll(0); });
process.on("SIGTERM", () => stopAll(0));

function open(url: string) {
  const [cmd, cmdArgs] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] :
    process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, cmdArgs, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

if (doctor) {
  console.log("Running the checks first (npm run doctor)…\n");
  const r = spawnSync(process.execPath, nodeArgs("src/scripts/doctor.ts"), { stdio: "inherit", env: process.env });
  if (r.status) {
    console.error("\n✗ The checks found a problem (see above). Fix it, or start without --doctor.");
    process.exit(r.status);
  }
  console.log("");
}

const steps: [string, string, string][] = [
  ["facilitator", "src/facilitator/server.ts", `${FACILITATOR_URL}/healthz`],
  ["seller", "src/seller/server.ts", `${SELLER_URL}/healthz`],
  ["web", "src/web/server.ts", `${WEB_URL}/api/session`],
];

console.log("Starting Kakasa: facilitator → seller → dashboard…\n");
for (const [name, file, health] of steps) {
  start(name, file);
  if (!(await waitFor(name, health))) {
    if (!stopping) {
      console.error(`\n✗ ${name} stopped before it was ready (${health}). Stopping.`);
      console.error(`  Try it on its own to see why:  npm run ${name}`);
      stopAll(1);
    }
    await new Promise(() => {}); // wait for exit
  }
}

const judgeOpen = /^(1|true|yes|on)$/i.test(process.env.JUDGE_OPEN || "");
const judge = judgeOpen || (process.env.JUDGE_PASSWORD || "").length > 0;
console.log(`
✓ Kakasa is running
   AI agent:     ${WEB_URL}/#agent
   Dashboard:    ${WEB_URL}
   Facilitator:  ${FACILITATOR_URL}
   Seller:       ${SELLER_URL}
   Judge demo:   ${judgeOpen ? "on, no passwords (anyone on the remote link is a judge; add --remote for the link)" : judge ? "on (judges sign in with JUDGE_PASSWORD)" : "off (set JUDGE_OPEN=true in .env to turn it on)"}
Press Ctrl+C to stop everything.
`);
if (openBrowser) open(`${WEB_URL}/#agent`);
if (remote) start("remote", "src/scripts/remote.ts", { critical: false });
