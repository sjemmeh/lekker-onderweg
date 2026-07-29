// Lekker Onderweg — personal loyalty-card viewer.
//
// Proxies the loyalty backend server-side: the API base, key and password all
// live in .env (never committed), so the browser never sees them and there is
// no CORS problem (the page and the API are same-origin).
//
// Two API calls are joined on CampaignID:
//   /cards/<id>/balance  -> per-card stamp progress (no shop name)
//   /campaigns           -> each campaign's Company (the shop) + logo
// The balance response has no shop field, so the shop comes from /campaigns.
//
// ponytail: there is no per-user login — a card is just its number, and the
// balance endpoint already returns ALL stamp cards for that number. One CARD_ID
// in .env = all your rewards.

import QRCode from "qrcode";
import { mkdirSync } from "node:fs";

const PORT = Number(Bun.env.PORT ?? 8787);
const CARD = (Bun.env.CARD_ID ?? "").trim();
const API = (Bun.env.NS_API_BASE ?? "").replace(/\/+$/, "");
const KEY = Bun.env.NS_SUBSCRIPTION_KEY ?? "";
const PROVIDER = Bun.env.NS_PROVIDER ?? "";
const PASSWORD = Bun.env.NS_PASSWORD ?? "";

// What the in-store scanner reads. The app's QR encodes the bare card number
// (verified by decoding the app's own QR). Change here if that ever differs.
const QR_PAYLOAD = CARD;

for (const [k, v] of Object.entries({ CARD_ID: CARD, NS_API_BASE: API, NS_SUBSCRIPTION_KEY: KEY, NS_PROVIDER: PROVIDER, NS_PASSWORD: PASSWORD }))
  if (!v) console.warn(`⚠  ${k} is empty in .env`);
// zonder deze blijven de afbeeldingen werken, ze komen dan alleen rechtstreeks
// van de bron in plaats van uit de lokale cache
if (!Bun.env.NS_IMG_HOST) console.warn("⚠  NS_IMG_HOST is empty in .env — afbeeldingen worden niet gecachet");

const authHeaders = { "Ocp-Apim-Subscription-Key": KEY, provider: PROVIDER, password: PASSWORD };
const apiGet = (path: string) =>
  fetch(`${API}${path}`, { headers: authHeaders, signal: AbortSignal.timeout(10_000) });

const prettyShop = (name: unknown) =>
  String(name ?? "Overig").replace(/´/g, "'").replace(/&#39;/g, "'").trim() || "Overig";

// CampaignID -> { shop, logo }. Campaigns rarely change, so fetch once and cache.
type ShopInfo = { shop: string; logo: string };
let shopMap: Map<number, ShopInfo> | null = null;
async function getShopMap(): Promise<Map<number, ShopInfo>> {
  if (shopMap) return shopMap;
  const r = await apiGet("/campaigns");
  const m = new Map<number, ShopInfo>();
  if (r.ok) {
    for (const c of (await r.json()) as any[]) {
      const co = c.Company || {};
      m.set(c.CampaignID, { shop: prettyShop(co.CompanyName), logo: co.logo || "" });
    }
    shopMap = m; // only cache a good result
  }
  return m;
}

// Bound to CARD from .env on purpose: behind a public tunnel this only ever
// reveals your own card, never an open lookup for arbitrary numbers.
async function balance(): Promise<Response> {
  if (!/^\d{6,25}$/.test(CARD))
    return Response.json({ error: "CARD_ID missing/invalid in .env (digits only)" }, { status: 400 });
  try {
    const [bRes, map] = await Promise.all([apiGet(`/cards/${CARD}/balance`), getShopMap()]);
    if (!bRes.ok) return new Response(await bRes.text(), { status: bRes.status });
    const cards = (await bRes.json()) as any[];
    for (const c of cards) {
      const s = map.get(c.CampaignID);
      c.Shop = s?.shop ?? "Overig";
      // route product images through our cache so the source is hit once each;
      // zonder NS_IMG_HOST laten we de link staan en laadt de browser hem direct
      const link = c.FrontImage?.[0]?.ImageLink;
      if (IMG_HOST && typeof link === "string" && link.startsWith(`https://${IMG_HOST}/`))
        c.FrontImage[0].ImageLink = "/img?u=" + encodeURIComponent(link);
    }
    return Response.json(cards);
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 502 });
  }
}

let qrSvg = "";
async function qr(): Promise<Response> {
  if (!qrSvg && /^\d+$/.test(QR_PAYLOAD))
    qrSvg = await QRCode.toString(QR_PAYLOAD, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
  return new Response(qrSvg || "<svg/>", { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
}

// --- product-image cache: fetch each CDN image once, then serve from disk ---
// Host waar de productafbeeldingen vandaan komen. Staat in .env (net als de rest
// van de API-gegevens) en dient meteen als allowlist voor /img, zodat dit geen
// open proxy wordt.
const IMG_HOST = (Bun.env.NS_IMG_HOST ?? "").trim();
const CACHE_DIR = new URL("./.cache/img/", import.meta.url).pathname;
mkdirSync(CACHE_DIR, { recursive: true });

async function image(u: string): Promise<Response> {
  let url: URL;
  try { url = new URL(u); } catch { return new Response("bad url", { status: 400 }); }
  if (url.protocol !== "https:" || url.hostname !== IMG_HOST) // no open proxy / SSRF
    return new Response("forbidden host", { status: 403 });
  const ext = url.pathname.toLowerCase().endsWith(".png") ? "png" : "jpg";
  const type = ext === "png" ? "image/png" : "image/jpeg";
  const path = `${CACHE_DIR}${Bun.hash(u).toString(16)}.${ext}`;
  const hit = Bun.file(path);
  const headers = { "content-type": type, "cache-control": "public, max-age=604800" };
  if (await hit.exists()) return new Response(hit, { headers });
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return new Response("upstream " + r.status, { status: 502 });
    const buf = await r.arrayBuffer();
    await Bun.write(path, buf);
    return new Response(buf, { headers });
  } catch (e) { return new Response(String(e), { status: 502 }); }
}

const MIME: Record<string, string> = {
  svg: "image/svg+xml; charset=utf-8", png: "image/png", ico: "image/x-icon",
  webmanifest: "application/manifest+json; charset=utf-8",
};
async function serveStatic(name: string): Promise<Response> {
  if (name.includes("..") || !/^[\w./-]+$/.test(name)) return new Response("bad", { status: 400 });
  const f = Bun.file(new URL("./public/" + name, import.meta.url).pathname);
  if (!(await f.exists())) return new Response("not found", { status: 404 });
  const ext = name.split(".").pop() ?? "";
  return new Response(f, { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "public, max-age=604800" } });
}

const page = await Bun.file(new URL("./index.html", import.meta.url)).text();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/" || pathname === "/index.html")
      // no-cache so an updated page always reaches installed PWAs; the assets it
      // references are versioned (?v=N) and stay long-cached
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
    if (pathname === "/api/balance") return balance();
    if (pathname === "/api/qr") return qr();
    if (pathname === "/api/card") return Response.json({ card: CARD });
    if (pathname === "/img") return image(new URL(req.url).searchParams.get("u") || "");
    if (pathname === "/manifest.webmanifest") return serveStatic("manifest.webmanifest");
    if (pathname === "/illustration.svg") return serveStatic("illustration.svg");
    if (pathname.startsWith("/logos/") || pathname.startsWith("/icons/") || pathname.startsWith("/stickers/"))
      return serveStatic(pathname.slice(1));
    return new Response("Not found", { status: 404 });
  },
});

// load on start: fetch once so bad credentials/card surface in the log immediately.
balance().then(async (r) => {
  let note = `HTTP ${r.status}`;
  if (r.ok) {
    const cards = (await r.clone().json()) as Array<{ TXArchived?: number; ChallengeOK?: boolean; Shop?: string }>;
    const stamps = cards.reduce((s, c) => s + (c.TXArchived ?? 0), 0);
    const full = cards.filter((c) => c.ChallengeOK).length;
    const shops = [...new Set(cards.map((c) => c.Shop))].join(", ");
    note = `${stamps} stamps, ${full} full — shops: ${shops}`;
  }
  console.log(`\n  Lekker Onderweg → http://localhost:${server.port}`);
  console.log(`  card ${CARD || "UNSET"} — ${note}\n`);
});
