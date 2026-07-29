// Haalt de merk-assets (logo's, spaarzegels, icoon, illustratie) uit de officiële
// APK en zet ze in app/public/. Die bestanden staan in .gitignore: ze zijn eigendom
// van NS/de winkels en horen niet in deze repository thuis.
//
// Gebruik:  bun run extract [pad/naar/bestand.xapk]
// Zonder argument wordt de nieuwste *.xapk in ~/Downloads gepakt.
//
// aapt2 is nodig omdat de XML in een APK binair is; de PNG's komen er direct uit.

import { $ } from "bun";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

// resources land in the app module (app/public/); those files are git-ignored
const OUT = new URL("../app/public/", import.meta.url).pathname;
const TMP = join(process.env.TMPDIR ?? "/tmp", "lekker-extract");

// PNG's die we 1-op-1 uit de APK kopiëren: bron -> doel
const STICKERS: [string, string][] = [
  ["ic_sticker_kiosk_active", "stickers/kiosk-on.png"],
  ["ic_sticker_kiosk_inactive", "stickers/kiosk-off.png"],
  ["ic_sticker_julias_active", "stickers/julias-on.png"],
  ["ic_sticker_julias_inactive", "stickers/julias-off.png"],
  ["ic_sticker_shk_active", "stickers/sh-on.png"],
  ["ic_sticker_shk_inactive", "stickers/sh-off.png"],
];
// VectorDrawables die we naar SVG omzetten
const VECTORS: [string, string][] = [
  ["ic_kiosk_logo_kleur", "logos/kiosk.svg"],
  ["ic_julias_logo_kleur", "logos/julias.svg"],
  ["ic_sh_logo_kleur", "logos/sh.svg"],
  ["ic_background", "illustration.svg"],
];

function findAapt2(): string {
  if (Bun.which("aapt2")) return "aapt2";
  const roots = [
    process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    join(homedir(), "Library/Android/sdk"), join(homedir(), "Android/Sdk"),
    "/usr/local/lib/android/sdk",
  ].filter(Boolean) as string[];
  for (const root of roots) {
    const bt = join(root, "build-tools");
    if (!existsSync(bt)) continue;
    for (const v of readdirSync(bt).sort().reverse()) {
      const p = join(bt, v, "aapt2");
      if (existsSync(p)) return p;
    }
  }
  console.error(
    "\n  aapt2 niet gevonden. Dit hoort bij de Android SDK build-tools.\n" +
    "  macOS:  brew install --cask android-commandlinetools\n" +
    "          sdkmanager 'build-tools;35.0.0'\n" +
    "  Of zet ANDROID_HOME naar je SDK.\n");
  process.exit(1);
}

function findXapk(): string {
  const arg = process.argv[2];
  if (arg) {
    if (!existsSync(arg)) { console.error(`  Bestand niet gevonden: ${arg}`); process.exit(1); }
    return arg;
  }
  // ./xapk eerst (dat is ook wat de container gemount krijgt), daarna Downloads.
  // In ./xapk pakken we elk archief — die map is er alleen voor dit doel. In
  // Downloads moet de naam kloppen, anders grijpen we zomaar een andere APK.
  const dirs: [string, boolean][] = [
    [new URL("../xapk/", import.meta.url).pathname, false],
    [join(homedir(), "Downloads"), true],
  ];
  for (const [dir, byName] of dirs) {
    if (!existsSync(dir)) continue;
    const hits = readdirSync(dir)
      .filter((f) => /\.(xapk|apkm|apks|apk)$/i.test(f))
      .filter((f) => !byName || /lekker|onderweg|spaarstation/i.test(f))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (hits.length) return hits[0];
  }
  console.error(
    "\n  Geen .xapk gevonden.\n" +
    "  Zoek naar 'lekker onderweg xapk' en zet het bestand in de map ./xapk\n" +
    "  (of in je Downloads-map). Of geef het pad mee: bun run extract <bestand>.\n");
  process.exit(1);
}

// AARRGGBB -> [#RRGGBB, alpha]
const colour = (c: string): [string, number] => {
  const h = c.replace("#", "");
  return h.length === 8 ? ["#" + h.slice(2), parseInt(h.slice(0, 2), 16) / 255] : ["#" + h, 1];
};
const CAP: Record<string, string> = { "0": "butt", "1": "round", "2": "square" };
const JOIN: Record<string, string> = { "0": "miter", "1": "round", "2": "bevel" };

/** VectorDrawable -> SVG. Stroke-attributen MOETEN mee, anders verdwijnen o.a.
 *  de omlijning van de croissant en de lijnen tussen de segmenten. */
function vectorToSvg(dump: string): string {
  const attr = (block: string, name: string) =>
    block.match(new RegExp(`${name}\\(0x[0-9a-f]+\\)=(#[0-9a-fA-F]+|[0-9.]+)`))?.[1];
  const vw = dump.match(/viewportWidth\S*=([\d.]+)/)?.[1] ?? "24";
  const vh = dump.match(/viewportHeight\S*=([\d.]+)/)?.[1] ?? "24";

  const paths: string[] = [];
  for (const block of dump.split("E: path").slice(1)) {
    const d = block.match(/pathData\S*=[\s\S]*?\(Raw: "([\s\S]*?)"\)/)?.[1];
    if (!d) continue;
    const a = [`d="${d}"`];

    const fc = attr(block, "fillColor");
    if (fc) {
      const [col, al0] = colour(fc);
      const al = al0 * Number(attr(block, "fillAlpha") ?? 1);
      a.push(`fill="${col}"`);
      if (al < 1) a.push(`fill-opacity="${al.toFixed(3)}"`);
    } else a.push('fill="none"');
    if (attr(block, "fillType") === "1") a.push('fill-rule="evenodd"');

    const sc = attr(block, "strokeColor");
    if (sc) {
      const [col, al0] = colour(sc);
      const al = al0 * Number(attr(block, "strokeAlpha") ?? 1);
      if (al0 > 0) {
        a.push(`stroke="${col}"`, `stroke-width="${attr(block, "strokeWidth") ?? 1}"`);
        if (al < 1) a.push(`stroke-opacity="${al.toFixed(3)}"`);
        const cap = attr(block, "strokeLineCap"); if (cap && CAP[cap]) a.push(`stroke-linecap="${CAP[cap]}"`);
        const jn = attr(block, "strokeLineJoin"); if (jn && JOIN[jn]) a.push(`stroke-linejoin="${JOIN[jn]}"`);
      }
    }
    paths.push(`<path ${a.join(" ")}/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${vw} ${vh}" fill="none">\n  `
    + paths.join("\n  ") + "\n</svg>\n";
}

// ---- uitvoeren ----
const aapt2 = findAapt2();
const src = findXapk();
console.log(`  bron : ${basename(src)}`);

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

// een .xapk/.apks is een zip met de base-APK erin; een los .apk gebruiken we direct
let apk = src;
if (!/\.apk$/i.test(src)) {
  await $`unzip -oq ${src} -d ${TMP}`.quiet();
  const inner = readdirSync(TMP).filter((f) => f.endsWith(".apk"));
  const base = inner.find((f) => !/^config\./i.test(f)) ?? inner[0];
  if (!base) { console.error("  Geen APK in het archief gevonden."); process.exit(1); }
  apk = join(TMP, base);
}
console.log(`  apk  : ${basename(apk)}`);

for (const d of ["logos", "stickers", "icons"]) mkdirSync(join(OUT, d), { recursive: true });

// 1. spaarzegels (PNG, rechtstreeks uit de APK)
await $`unzip -oq ${apk} "res/drawable/ic_sticker_*.png" -d ${TMP}/res`.quiet();
for (const [name, dest] of STICKERS) {
  const from = join(TMP, "res/res/drawable", `${name}.png`);
  if (!existsSync(from)) { console.error(`  ontbreekt: ${name}.png`); process.exit(1); }
  await Bun.write(join(OUT, dest), Bun.file(from));
  console.log(`  ✓ ${dest}`);
}

// 2. logo's + illustratie (VectorDrawable -> SVG)
for (const [name, dest] of VECTORS) {
  const dump = await $`${aapt2} dump xmltree ${apk} --file res/drawable/${name}.xml`.text();
  const svg = vectorToSvg(dump);
  if (!svg.includes("<path")) { console.error(`  kon ${name}.xml niet omzetten`); process.exit(1); }
  await Bun.write(join(OUT, dest), svg);
  console.log(`  ✓ ${dest}`);
}

// 3. app-icoon: achtergrond + voorgrond over elkaar = het icoon uit de launcher
const layers = await Promise.all(["ic_launcher_background", "ic_launcher_foreground"].map(
  async (n) => vectorToSvg(await $`${aapt2} dump xmltree ${apk} --file res/drawable/${n}.xml`.text())));
const inner = layers.map((s) => s.replace(/^[\s\S]*?<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "").trim());
await Bun.write(join(OUT, "icons/icon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 108 108" fill="none">\n${inner.join("\n")}\n</svg>\n`);
console.log("  ✓ icons/icon.svg");

// PNG-varianten voor het startscherm; rsvg/sips zijn optioneel, vandaar de nette melding
const png = async (size: number, dest: string) => {
  if (Bun.which("rsvg-convert")) {
    await $`rsvg-convert -w ${size} -h ${size} ${join(OUT, "icons/icon.svg")} -o ${join(OUT, dest)}`.quiet();
  } else if (Bun.which("qlmanage")) {                       // macOS zonder extra tools
    await $`qlmanage -t -s ${size} -o ${TMP} ${join(OUT, "icons/icon.svg")}`.quiet();
    await Bun.write(join(OUT, dest), Bun.file(join(TMP, "icon.svg.png")));
  } else return false;
  console.log(`  ✓ ${dest}`);
  return true;
};
if (!(await png(512, "icons/icon-512.png"))) {
  console.log("  ! geen rsvg-convert gevonden — PNG-iconen overgeslagen (SVG is er wel)");
} else {
  await png(192, "icons/icon-192.png");
  await png(180, "icons/apple-touch-icon.png");
}

rmSync(TMP, { recursive: true, force: true });
console.log("\n  Klaar. De assets staan in app/public/ en worden niet meegecommit.\n");
