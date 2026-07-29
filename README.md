# Lekker Onderweg

Ik wilde mijn spaarzegels van Kiosk, Julia's en Stationshuiskamer kunnen bekijken
zonder de app van NS. Dit is een klein webapp die je huidige saldo ophaalt, je
spaarkaarten per winkel laat zien, en je QR-code toont zodat je bij de kassa
gewoon kunt scannen.

Op de telefoon kun je hem aan je startscherm toevoegen als webapp.

De reden dat dit werkt: de spaarkaart heeft geen account of login. Je kaartnummer
(de cijfers onder je QR-code) is je "account". 
Het feit dat de app niet mee kan naar een nieuwe telefoon is gierigheid/luiheid van de developers. 
In realiteit hoeft er alleen een "restore" knop toegevoegd te worden waar je je kaartnummer zou kunnen importeren en het zou gelijk op je nieuwe telefoon kunnen werken. Het feit dat dit niet standaard is en in de faq staat dat het niet mogelijk is is ronduit schandalig.
Daar is deze webapp voor gemaakt. Een proof of concept om mijn saldo mee te nemen naar een nieuwe telefoon.

## Even vooraf

De image assets zijn eigendom van de NS, dus die zitten niet in deze repo. Bij het opzetten haal je ze uit je eigen
kopie van de app. Kost je één commando, en het scheelt mij een DMCA-takedown.

## Opzetten

```bash
git clone https://github.com/sjemmeh/lekker-onderweg
cd lekker-onderweg
```

### De plaatjes ophalen

Download de xAPK van een externe site. Ik lever deze hier ook niet aan om dmca redenen (een google zoekopdracht naar lekker onderweg xAPK en vind je hem zo). Zet het bestand in de map `xapk/`.

Draai je met Docker, dan ben je hier klaar: de build pakt hem er zelf uit. Staat er
geen xapk, dan stopt de build met een melding in plaats van dat je later een halve
app hebt.

Wil je het zonder Docker doen, dan heb je [Bun](https://bun.sh) nodig en `aapt2`
uit de Android SDK:

```bash
brew install --cask android-commandlinetools   # macOS
sdkmanager 'build-tools;35.0.0'
```

Staat je SDK ergens anders, zet dan `ANDROID_HOME`. Daarna:

```bash
bun install
bun run extract
```

Die pakt de nieuwste `.xapk` uit `xapk/`, en anders uit je Downloads. Je kunt ook
een pad meegeven: `bun run extract ~/Downloads/lekker-onderweg.xapk`. Alles komt in
`app/public/` terecht. Eén keer doen en je bent klaar.

### Instellen

```bash
cp .env.example .env
```

`CARD_ID` is je kaartnummer, de cijfers die onder je QR-code staan. De
`NS_*`-variabelen zijn de API-URL, de drie auth-headers die de app meestuurt, en
de host waar de productplaatjes vandaan komen; wat elke variabele doet staat in
`.env.example`. Let op dat je `NS_PASSWORD` tussen aanhalingstekens zet als er een
`#` in zit, anders leest Bun de rest als commentaar.

Die API-gegevens heb ik niet standaard meegeleverd, sinds dit proprietary van is is, en ze zijn ook niet uit de APK te trekken.
Deze moet je zelf uit de officiele app zien te trekken.
Hulp nodig? Mail me even op
jaimie@sjemmeh.com.

### Starten

```bash
bun start
```

Staat op <http://localhost:8787>. `bun run dev` als je aan het sleutelen bent, die
herstart bij wijzigingen.

## Docker

```bash
docker compose up -d --build
```

Host-poort 8790 gaat naar 8787 in de container. `.env` wordt read-only ingelezen en
de cache met productafbeeldingen blijft in een volume staan.

De build haalt de plaatjes zelf uit de xapk in `xapk/`, dus `bun run extract` hoef
je hier niet te draaien. `aapt2` zit in de build-stage; die is vastgezet op amd64
omdat Google hem alleen voor x86_64 uitgeeft. Op een arm-machine (M1/M2) draait
alleen dat stukje geëmuleerd, de uiteindelijke image blijft native.

## Hoe het in elkaar zit

```
app/        de webapp: server.ts en index.html
  public/   hier komen de plaatjes (staat in .gitignore)
extract/    haalt die plaatjes uit de APK
xapk/       hier zet je de xapk neer (wordt ook niet meegecommit)
.env        jouw kaartnummer en de API-gegevens
```

De server zit ertussen omdat het niet anders kan: de API wil drie eigen headers,
en zijn CORS-preflight geeft een 500 op de subscription-key. Vanuit de browser
komt dat dus nooit goed. Nu voegt de server de headers toe en praat de pagina
alleen met zijn eigen origin. Prettige bijkomstigheid is dat je gegevens niet in
de browser terechtkomen.

Verder haalt hij twee dingen op: `/cards/<nummer>/balance` voor je zegels, en
`/campaigns` voor de winkelnamen, want in het saldo staat niet bij welke winkel een
kaart hoort. Die twee plakt hij aan elkaar op `CampaignID`. Productplaatjes gaan
via `/img`, die ze één keer van hun CDN haalt en daarna van schijf serveert. De
pagina ververst zichzelf elke 10 seconden zolang je hem open hebt staan.

## Licentie

De code is MIT, zie [LICENSE](LICENSE).

Dit project heeft niets met NS, Kiosk, Julia's of Stationshuiskamer te maken en is
niet door hen goedgekeurd. Hun merknamen en afbeeldingen zijn van hen, en worden
hier dus ook niet meegeleverd.
