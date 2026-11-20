/**
 * Shared web assets for every Kakasa page:
 *   /assets/cord.css            the design system (src/ui/cord.css)
 *   /assets/brand/<file>        logo, icons, link-preview images (src/ui/brand)
 *   /favicon.ico, /manifest.webmanifest
 */
import type { Request, Response, Router } from "express";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const APP_NAME = process.env.APP_NAME || "Kakasa";
const CSS_PATH = "src/ui/cord.css";
const BRAND_DIR = "src/ui/brand";
const TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon" };

const css = () => (existsSync(CSS_PATH) ? readFileSync(CSS_PATH, "utf8") : readFileSync(new URL("./cord.css", import.meta.url), "utf8"));
function brandFile(name: string): Buffer | null {
  const file = basename(name); // no paths, only files in the brand folder
  if (!TYPES[extname(file)]) return null;
  const p = `${BRAND_DIR}/${file}`;
  if (existsSync(p)) return readFileSync(p);
  const u = new URL(`./brand/${file}`, import.meta.url);
  return existsSync(u) ? readFileSync(u) : null;
}
function sendBrand(res: Response, file: string) {
  const buf = brandFile(file);
  if (!buf) return res.status(404).end();
  res.type(TYPES[extname(file)]).set("cache-control", "public, max-age=86400").send(buf);
}

export function mountAssets(app: Pick<Router, "get">) {
  app.get("/assets/cord.css", (_req: Request, res: Response) => res.type("text/css").set("cache-control", "public, max-age=300").send(css()));
  app.get("/assets/brand/:file", (req: Request, res: Response) => sendBrand(res, req.params.file));
  app.get("/favicon.ico", (_req: Request, res: Response) => sendBrand(res, "favicon.ico"));
  app.get("/manifest.webmanifest", (_req: Request, res: Response) =>
    res.type("application/manifest+json").json({
      name: APP_NAME, short_name: APP_NAME, start_url: "/", display: "standalone",
      background_color: "#0a1430", theme_color: "#0a1430",
      icons: [
        { src: "/assets/brand/kakasa-mark-192.png", sizes: "192x192", type: "image/png" },
        { src: "/assets/brand/kakasa-mark-512.png", sizes: "512x512", type: "image/png" },
      ],
    }));
}
