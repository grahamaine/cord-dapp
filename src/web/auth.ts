/**
 * Owner login for the dashboard. Turned on by DASHBOARD_PASSWORD in .env (required for `npm run remote`).
 *
 * - Every page and API call needs a session, except the login page itself and the shared stylesheet.
 * - Sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie (Secure over HTTPS), 12 hours.
 * - 5 wrong passwords from one address lock it out for 15 minutes; every login attempt goes in the audit log.
 * - Without a password, requests that arrive through a tunnel are refused outright, so the dashboard
 *   can never be exposed by accident.
 * Releasing money still needs the owner's wallet signature on top of this login.
 *
 * Judge demo mode: set JUDGE_PASSWORD too (8+ characters, different from DASHBOARD_PASSWORD). Signing in with
 * it gives a "judge" session: the whole flow on demo invoices, capped releases without the owner's wallet, and
 * no access to owner-only actions (policy, pause/resume, anchoring, CIS-8 key links). See src/lib/judge.ts.
 *
 * Open judge mode (JUDGE_OPEN=true): no passwords for judges. Anyone arriving through the remote link is a judge
 * straight away (same limits as above); on this computer you are the owner without signing in. The owner can
 * still sign in through the link with DASHBOARD_PASSWORD, if one is set.
 */
import type express from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { audit } from "../lib/audit.js";

const COOKIE = "cord_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
export type Role = "owner" | "judge";
const sessions = new Map<string, { exp: number; role: Role }>(); // token -> expiry + role
const fails = new Map<string, { n: number; until: number }>();
const GLOBAL_MAX = 20; let globalFails: number[] = []; // timestamps of recent wrong passwords from anywhere

export const password = () => process.env.DASHBOARD_PASSWORD || "";
export const authEnabled = () => password().length > 0;
const judgePassword = () => process.env.JUDGE_PASSWORD || "";
/** Open judge mode: judges need no password (see the header). */
export const judgeOpen = () => /^(1|true|yes|on)$/i.test(process.env.JUDGE_OPEN || "");
/** Judge demo mode is on when it's open, or when the owner login is on and a separate JUDGE_PASSWORD (8+ characters) is set. */
export const judgeEnabled = () => judgeOpen() || (authEnabled() && judgePassword().length >= 8 && judgePassword() !== password());

/** Owner-only actions a judge session may not use. */
const OWNER_ONLY: [string, RegExp][] = [
  ["PUT", /^\/api\/policy$/],
  ["POST", /^\/api\/agent\/(pause|resume)$/],
  ["POST", /^\/api\/audit\/anchor$/],
  ["POST", /^\/api\/xchain\/links\//],
  ["POST", /^\/api\/locks\/[^/]+\/release-challenge$/],
];

const viaTunnel = (req: express.Request) => Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
const clientIp = (req: express.Request) => String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown");
const isHttps = (req: express.Request) => req.headers["x-forwarded-proto"] === "https" || Boolean(req.headers["cf-visitor"]?.toString().includes("https"));
const sha = (s: string) => createHash("sha256").update(s).digest();

function tokenOf(req: express.Request) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return m?.[1];
}
function sessionOf(req: express.Request) {
  const t = tokenOf(req);
  if (!t) return undefined;
  const s = sessions.get(t);
  if (!s || s.exp < Date.now()) { sessions.delete(t); return undefined; }
  return s;
}
const validSession = (req: express.Request) => Boolean(sessionOf(req));
/** Who is using the dashboard. Without the login (this computer only) it is always the owner. */
export function roleOf(req: express.Request): Role {
  if (judgeOpen()) return sessionOf(req)?.role ?? (viaTunnel(req) ? "judge" : "owner");
  if (!authEnabled()) return "owner";
  return sessionOf(req)?.role ?? "owner";
}
function setCookie(res: express.Response, req: express.Request, value: string, maxAgeMs: number) {
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${isHttps(req) ? "; Secure" : ""}`);
}

const loginPage = (appName: string) =>
  readFileSync(new URL("./login.html", import.meta.url), "utf8").replaceAll("{{APP_NAME}}", appName);

export function mountAuth(app: express.Express, appName: string) {
  app.use((req, res, next) => {
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    if (judgeOpen()) {
      // No passwords: this computer = owner; the remote link = judge (unless signed in as the owner).
      if (roleOf(req) === "judge" && OWNER_ONLY.some(([m, re]) => req.method === m && re.test(req.path)))
        return res.status(403).json({ error: "Judge demo: only the owner can do this.", refused: true });
      return next();
    }
    if (!authEnabled()) {
      if (viaTunnel(req)) return res.status(403).type("text").send("Remote access is off: set DASHBOARD_PASSWORD in .env and restart the dashboard.");
      return next();
    }
    if (req.path === "/login" || req.path === "/api/login" || req.path.startsWith("/assets/")) return next();
    const s = sessionOf(req);
    if (s) {
      if (s.role === "judge" && OWNER_ONLY.some(([m, re]) => req.method === m && re.test(req.path)))
        return res.status(403).json({ error: "Judge demo: only the owner can do this.", refused: true });
      return next();
    }
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Please sign in again.", login: true });
    return res.redirect(302, "/login");
  });

  app.get("/login", (req, res) => ((authEnabled() || judgeOpen()) && validSession(req) ? res.redirect(302, "/") : res.type("html").send(loginPage(appName))));

  app.post("/api/login", (req, res) => {
    if (!authEnabled()) return res.json({ ok: true });
    const ip = clientIp(req);
    const f = fails.get(ip);
    if (f && f.until > Date.now()) {
      return res.status(429).json({ error: `Too many wrong passwords. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} min.` });
    }
    globalFails = globalFails.filter((t) => t > Date.now() - LOCK_MS);
    if (globalFails.length >= GLOBAL_MAX) return res.status(429).json({ error: "Too many wrong passwords recently. Sign-in is paused for 15 minutes." });
    const given = String(req.body?.password ?? "");
    const isOwner = given.length > 0 && timingSafeEqual(sha(given), sha(password()));
    const isJudge = !isOwner && judgeEnabled() && given.length > 0 && timingSafeEqual(sha(given), sha(judgePassword()));
    if (!isOwner && !isJudge) {
      const n = (f && f.until < Date.now() && f.n >= MAX_FAILS ? 0 : f?.n ?? 0) + 1;
      fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      globalFails.push(Date.now());
      audit({ actor: "system", op: "login", outcome: "refused", detail: `Wrong dashboard password from ${viaTunnel(req) ? "remote link" : "this computer"} (${ip})${n >= MAX_FAILS ? ", locked for 15 min" : ""}` });
      return res.status(401).json({ error: n >= MAX_FAILS ? "Too many wrong passwords. Locked for 15 minutes." : "Wrong password." });
    }
    fails.delete(ip);
    const token = randomBytes(32).toString("hex");
    const role: Role = isJudge ? "judge" : "owner";
    sessions.set(token, { exp: Date.now() + SESSION_MS, role });
    setCookie(res, req, token, SESSION_MS);
    audit({ actor: role, op: "login", outcome: "ok", detail: `${isJudge ? "Judge (demo mode)" : "Owner"} signed in to the dashboard from ${viaTunnel(req) ? "the remote link" : "this computer"} (${ip})` });
    res.json({ ok: true, role });
  });

  app.post("/api/logout", (req, res) => {
    const t = tokenOf(req);
    if (t) sessions.delete(t);
    setCookie(res, req, "", 0);
    res.json({ ok: true });
  });
}
