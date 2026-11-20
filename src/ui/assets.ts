/** Serves the shared Cord stylesheet (src/ui/cord.css) at /assets/cord.css for every Cord web page. */
import type { Request, Response, Router } from "express";
import { existsSync, readFileSync } from "node:fs";

const CSS_PATH = "src/ui/cord.css";
const css = () => (existsSync(CSS_PATH) ? readFileSync(CSS_PATH, "utf8") : readFileSync(new URL("./cord.css", import.meta.url), "utf8"));

export function mountAssets(app: Pick<Router, "get">) {
  app.get("/assets/cord.css", (_req: Request, res: Response) => res.type("text/css").set("cache-control", "public, max-age=300").send(css()));
}
