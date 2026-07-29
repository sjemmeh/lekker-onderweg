# ---- 1. merk-assets uit de APK halen -------------------------------------
# Gebeurt tijdens de build: staat er geen .xapk in ./xapk, dan stopt de build
# hier met een duidelijke melding. aapt2 komt als losse binary van Google's
# Maven, dus de hele Android SDK is niet nodig. Debian-basis (niet alpine):
# aapt2 is tegen glibc gelinkt.
# Vastgezet op amd64: Google publiceert aapt2 alleen voor linux-x86_64. Op een
# arm64-machine draait alleen deze stage geëmuleerd; het eindresultaat zijn
# gewoon bestanden, dus de uiteindelijke image blijft native.
FROM --platform=linux/amd64 oven/bun:1 AS assets

ARG AAPT2_VERSION=8.7.3-12006047
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip curl librsvg2-bin ca-certificates \
 && curl -fsSL -o /tmp/aapt2.jar \
      "https://dl.google.com/dl/android/maven2/com/android/tools/build/aapt2/${AAPT2_VERSION}/aapt2-${AAPT2_VERSION}-linux.jar" \
 && unzip -p /tmp/aapt2.jar aapt2 > /usr/local/bin/aapt2 \
 && chmod +x /usr/local/bin/aapt2 \
 && rm -f /tmp/aapt2.jar && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY extract ./extract
COPY app/public ./app/public
COPY xapk ./xapk
RUN bun extract/extract-assets.ts

# ---- 2. dependencies ------------------------------------------------------
FROM oven/bun:1-alpine AS deps
WORKDIR /srv
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---- 3. de webapp ---------------------------------------------------------
FROM oven/bun:1-alpine
WORKDIR /srv
COPY --from=deps /srv/node_modules ./node_modules
COPY package.json bun.lock ./
COPY app ./app
# de uitgepakte assets overschrijven de (lege) public-map uit de repo
COPY --from=assets /srv/app/public ./app/public
# cache-map van de non-root gebruiker, zodat het volume schrijfbaar blijft
RUN mkdir -p /srv/app/.cache/img && chown -R bun:bun /srv
USER bun
EXPOSE 8787
# .env wordt bij het draaien gemount, niet mee-gebakken
CMD ["bun", "app/server.ts"]
