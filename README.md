# NB Boktrend (PWA)

En enkel Progressive Web App som viser trendlinje for hvor mange bøker per år som matcher en streng i Nasjonalbibliotekets søke-API.

## Funksjoner

- Søker i NB API med `FULL_TEXT_SEARCH`
- Filtrerer til bøker (`filter=mediatype:bøker`)
- Henter årsaggregering (`aggs=year:200:termasc`)
- Viser trendlinje med Recharts
- Kan installeres som PWA (manifest + service worker)

## Kom i gang

```bash
npm install
npm run dev
```

## Bygg og lint

```bash
npm run lint
npm run build
```

## GitHub Actions

Workflow ligger i `.github/workflows/ci.yml` og kjører:

1. `npm ci`
2. `npm run lint`
3. `npm run build`
