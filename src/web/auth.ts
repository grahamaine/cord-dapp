/**
 * Owner login for the dashboard. Turned on by DASHBOARD_PASSWORD in .env (required for `npm run remote`).
 *
 * - Every page and API call needs a session, except the login page itself and the shared stylesheet.
 * - Sessions: random 256-bit token in an HttpOnly, SameSite=Strict cookie (Secure over HTTPS), 12 hours.
 * - 5 wrong passwords from one address lock it out for 15 minutes; every login attempt goes in the audit log.
 * - Without a password, requests that arrive through a tunnel are refused outright, so the dashboard
 *   can never be exposed by accident.
 * Releasing money still needs the owner's wallet signature on top of this login.
 */
import type express from "express";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { audit } from "../lib/audit.js";

const COOKIE = "cord_session";
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;
const sessions = new Map<string, number>(); // token -> expiry
const fails = new Map<string, { n: number; until: number }>();
const GLOBAL_MAX = 20; let globalFails: number[] = []; // timestamps of recent wrong passwords from anywhere

export const password = () => process.env.DASHBOARD_PASSWORD || "";
export const authEnabled = () => password().length > 0;

const viaTunnel = (req: express.Request) => Boolean(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]);
const clientIp = (req: express.Request) => String(req.headers["cf-connecting-ip"] || req.socket.remoteAddress || "unknown");
const isHttps = (req: express.Request) => req.headers["x-forwarded-proto"] === "https" || Boolean(req.headers["cf-visitor"]?.toString().includes("https"));
const sha = (s: string) => createHash("sha256").update(s).digest();

function tokenOf(req: express.Request) {
  const m = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-f0-9]{64})`));
  return m?.[1];
}
function validSession(req: express.Request) {
  const t = tokenOf(req);
  if (!t) return false;
  const exp = sessions.get(t);
  if (!exp || exp < Date.now()) { if (t) sessions.delete(t); return false; }
  return true;
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
    if (!authEnabled()) {
      if (viaTunnel(req)) return res.status(403).type("text").send("Remote access is off: set DASHBOARD_PASSWORD in .env and restart the dashboard.");
      return next();
    }
    if (req.path === "/login" || req.path === "/api/login" || req.path.startsWith("/assets/")) return next();
    if (validSession(req)) return next();
    if (req.path.startsWith("/api/")) return res.status(401).json({ error: "Please sign in again.", login: true });
    return res.redirect(302, "/login");
  });

  app.get("/login", (req, res) => (authEnabled() && validSession(req) ? res.redirect(302, "/") : res.type("html").send(loginPage(appName))));

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
    const ok = given.length > 0 && timingSafeEqual(sha(given), sha(password()));
    if (!ok) {
      const n = (f && f.until < Date.now() && f.n >= MAX_FAILS ? 0 : f?.n ?? 0) + 1;
      fails.set(ip, { n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
      globalFails.push(Date.now());
      audit({ actor: "system", op: "login", outcome: "refused", detail: `Wrong dashboard password from ${viaTunnel(req) ? "remote link" : "this computer"} (${ip})${n >= MAX_FAILS ? ", locked for 15 min" : ""}` });
      return res.status(401).json({ error: n >= MAX_FAILS ? "Too many wrong passwords. Locked for 15 minutes." : "Wrong password." });
    }
    fails.delete(ip);
    const token = randomBytes(32).toString("hex");
    sessions.set(token, Date.now() + SESSION_MS);
    setCookie(res, req, token, SESSION_MS);
    audit({ actor: "owner", op: "login", outcome: "ok", detail: `Owner signed in to the dashboard from ${viaTunnel(req) ? "the remote link" : "this computer"} (${ip})` });
    res.json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    const t = tokenOf(req);
    if (t) sessions.delete(t);
    setCookie(res, req, "", 0);
    res.json({ ok: true });
  });
}
