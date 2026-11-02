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
// balance endpoint already returns ALL stamp cards for that number. The card
// comes from the URL: https://<host>/<cardnumber>. Anyone with that URL sees
// that card, so treat the link like the QR code itself.

import QRCode from "qrcode";
import { mkdirSync } from "node:fs";

const PORT = Number(Bun.env.PORT ?? 8787);
const API = (Bun.env.NS_API_BASE ?? "").replace(/\/+$/, "");
const KEY = Bun.env.NS_SUBSCRIPTION_KEY ?? "";
const PROVIDER = Bun.env.NS_PROVIDER ?? "";
const PASSWORD = Bun.env.NS_PASSWORD ?? "";

// The in-store scanner reads the bare card number (verified by decoding the
// app's own QR), so the URL segment is also the QR payload.
const CARD_RE = /^\d{6,25}$/;

for (const [k, v] of Object.entries({ NS_API_BASE: API, NS_SUBSCRIPTION_KEY: KEY, NS_PROVIDER: PROVIDER, NS_PASSWORD: PASSWORD }))
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

async function balance(card: string): Promise<Response> {
  if (!CARD_RE.test(card))
    return Response.json({ error: "kaartnummer ontbreekt/ongeldig (alleen cijfers)" }, { status: 400 });
  try {
    const [bRes, map] = await Promise.all([apiGet(`/cards/${card}/balance`), getShopMap()]);
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

async function qr(card: string): Promise<Response> {
  const svg = CARD_RE.test(card) ? await QRCode.toString(card, { type: "svg", margin: 1, errorCorrectionLevel: "M" }) : "<svg/>";
  return new Response(svg, { headers: { "content-type": "image/svg+xml; charset=utf-8" } });
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
const manifest = await Bun.file(new URL("./public/manifest.webmanifest", import.meta.url)).json();

// Geen kaart in de URL: vraag erom en stuur door naar /<nummer>.
const landing = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Lekker Onderweg</title>
<form onsubmit="location='/'+card.value.replace(/\\D/g,'');return false"
      style="font-family:sans-serif;max-width:360px;margin:20vh auto;padding:0 16px;color:#5541a8">
  <label>Kaartnummer (de cijfers onder je QR-code)<br>
    <input name="card" inputmode="numeric" pattern="[0-9 ]{6,30}" required autofocus
           style="width:100%;font-size:18px;margin:8px 0;padding:8px"></label>
  <button style="font-size:16px;padding:8px 16px">Open</button>
</form>`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    const html = { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" };
    if (pathname === "/") return new Response(landing, { headers: html });
    const m = pathname.match(/^\/(\d{6,25})\/?$/);
    if (m)
      // no-cache so an updated page always reaches installed PWAs; the assets it
      // references are versioned (?v=N) and stay long-cached. The manifest link
      // carries the card so an installed PWA opens on this card again.
      return new Response(page.replace("/manifest.webmanifest", `/manifest.webmanifest?card=${m[1]}`), { headers: html });
    const card = searchParams.get("card") || "";
    if (pathname === "/api/balance") return balance(card);
    if (pathname === "/api/qr") return qr(card);
    if (pathname === "/img") return image(searchParams.get("u") || "");
    if (pathname === "/manifest.webmanifest")
      return Response.json({ ...manifest, id: `/${card}`, start_url: `/${card}`, scope: `/${card}` },
        { headers: { "content-type": MIME.webmanifest } });
    if (pathname === "/illustration.svg") return serveStatic("illustration.svg");
    if (pathname.startsWith("/logos/") || pathname.startsWith("/icons/") || pathname.startsWith("/stickers/"))
      return serveStatic(pathname.slice(1));
    return new Response("Not found", { status: 404 });
  },
});

// campaigns once at start so bad credentials surface in the log immediately
getShopMap().then((m) => {
  console.log(`\n  Lekker Onderweg → http://localhost:${server.port}/<kaartnummer>`);
  console.log(`  campaigns: ${m.size ? [...new Set([...m.values()].map((s) => s.shop))].join(", ") : "NONE (check NS_* in .env)"}\n`);
});
