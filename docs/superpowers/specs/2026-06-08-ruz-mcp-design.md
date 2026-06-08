# RÚZ MCP — Návrh (design spec)

**Dátum:** 2026-06-08
**Projekt:** `RUZ-MCP` (Register účtovných závierok SR)
**Stav:** schválený návrh, pripravený na implementačný plán

---

## 1. Účel

Read-only MCP server nad verejným API Registra účtovných závierok SR
(`https://www.registeruz.sk/cruz-public/api`). Slúži pri preverovaní klienta
alebo protistrany (KYC/AML, due diligence, litigácia) na získanie
**destilovaného viacročného finančného profilu** subjektu podľa IČO, s možnosťou
dostať sa k plným výkazom a originálnym PDF dokumentom.

Server NErieši:
- vyhľadávanie podľa názvu (RÚZ API pozná len IČO/DIČ; preklad názov→IČO rieši
  agent cez ORSR-MCP a výsledné IČO posunie sem),
- scraping HTML (všetko beží cez čisté JSON API),
- generovanie dokumentov ani analytické komentáre nad rámec výpočtu ukazovateľov.

## 2. API — overené fakty

Base: `https://www.registeruz.sk/cruz-public/api`

| Endpoint | Vstup | Výstup |
|---|---|---|
| `/uctovne-jednotky` | `ico=`, `dic=`, `zmenene-od=`, `pokracovat-za-id=`, `max-zaznamov=` | `{"id":[...],"existujeDalsieId":bool}` |
| `/uctovna-jednotka` | `id=` | detail jednotky |
| `/uctovna-zavierka` | `id=` | metadáta závierky + `idUctovnychVykazov[]` |
| `/uctovny-vykaz` | `id=` | výkaz: `obsah`, `idSablony`, `prilohy[]` |
| `/vyrocna-sprava` | `id=` | výročná správa + prílohy |
| `/sablona` | `id=` | šablóna: `tabulky[]` s `hlavicka[]` a `data[]` (popisy buniek) |
| (príloha) | `id=` prílohy | binárka PDF (download) |

**Dátový model (reťazec):**
```
Účtovná jednotka (ICO → id)
  ├─ idUctovnychZavierok[]  → Účtovná závierka (obdobie, typ, konsolidovaná)
  │                              └─ idUctovnychVykazov[] → Účtovný výkaz
  │                                                          ├─ obsah (čísla)
  │                                                          ├─ idSablony
  │                                                          └─ prilohy[] (PDF)
  └─ idVyrocnychSprav[]     → Výročná správa (+ prílohy PDF)
```

**Detail jednotky** obsahuje: `nazovUJ`, `ico`, `dic`, `sidlo`/`ulica`/`mesto`/`psc`,
`skNace`, `pravnaForma`, `velkostOrganizacie`, `datumZalozenia`, `konsolidovana`,
`zdrojDat`, `idUctovnychZavierok[]`, `idVyrocnychSprav[]`, `stav`.

**Výkaz `obsah`:** `{"tabulky":[{"nazov":{"sk":...},"data":[<hodnoty row-major>]}]}`.
**Šablóna `tabulky[].data[]`:** paralelné pole na rovnakých indexoch s popismi buniek
(názov riadku, štatutárne „číslo riadku", stĺpec: Bežné / Bezprostredne predchádzajúce
účtovné obdobie). Spojenie hodnota↔popis je **podľa indexu**.

**Overené hrany:**
- IFRS / banky / poisťovne / „Oznámenie o dátume schválenia" majú `obsah: {}` —
  štruktúrované čísla NEEXISTUJÚ, sú len v PDF prílohe (napr. ESET konsolidovaná,
  Slovenská pošta a.s.).
- `stav: "NEVEREJNÁ"` / `"ZMAZANÉ"` — jednotka/závierka bez dát.
- Štandardná podvojná závierka (Súvaha Úč POD 1-01, šablóna id 21) má `obsah`
  naplnený a štatutárne čísla riadkov stabilné naprieč rokmi.

## 3. Architektúra

Zrkadlí ORSR-MCP. TypeScript/ESM (`"type":"module"`), runtime závislosti len
`@modelcontextprotocol/sdk` + `zod`, natívny `fetch`, dev: `tsx` + `vitest` + `typescript`.

```
src/
  ruz-client.ts      # tenký typovaný klient nad API + cache šablón
  financials.ts      # normalizácia: index↔číslo riadku, mapovanie ukazovateľov, trend
  mcp-server.ts      # createRuzMcpServer(): registrácia 8 toolov
  server.ts          # stdio transport (StdioServerTransport)
  server-http.ts     # StreamableHTTP transport
```

**Jednotky a ich zodpovednosti:**
- `ruz-client.ts` — IBA HTTP a tvar dát. Funkcie: `findEntityIdsByIco`,
  `findEntityIdsByDic`, `getEntity`, `getStatement`, `getReport`, `getTemplate`,
  `getAnnualReport`, `downloadAttachment`. In-memory cache šablón (kľúč `idSablony`,
  zdieľaná medzi firmami/rokmi, mení sa zriedka). Žiadna biznis logika.
- `financials.ts` — IBA normalizácia, žiadne HTTP. Vstup: výkaz + šablóna. Buduje
  `index → {cisloRiadku, label, stlpec}` mapu zo šablóny, extrahuje ukazovatele,
  zostavuje viacročný trend. Plne unit-testovateľné na fixtures.
- `mcp-server.ts` — orchestrácia: reťazí klienta + financials, formátuje výstup
  toolov. Žiadne priame `fetch`.

## 4. Nástroje (8)

| Tool | Vstup | Výstup |
|---|---|---|
| `ruz_find_entity` | `ico` alebo `dic` | jednotka(y): názov, sídlo, NACE, právna forma, veľkosť, konsolidovaná, `stav`, počty/ID závierok a výročných správ |
| `ruz_financial_profile` | `ico`, `years?` (default 5), `consolidated?` | **headline**: viacročný trend ukazovateľov (§5) + per-rok príznak dostupnosti štruktúrovaných dát |
| `ruz_list_statements` | `entityId` alebo `ico` | zoznam závierok: obdobie od/do, typ, konsolidovaná, dátumy podania/schválenia, ID výkazov |
| `ruz_get_statement` | `statementId` | detail jednej závierky + metadáta jej výkazov |
| `ruz_get_report` | `reportId` | plný čitateľný výkaz: riadky (číslo + názov) × stĺpce (bežné/predchádzajúce); pri prázdnom `obsah` príznak `structured_data_unavailable` + odkaz na prílohu |
| `ruz_list_annual_reports` | `entityId` alebo `ico` | výročné správy jednotky |
| `ruz_list_attachments` | `statementId` / `reportId` / `annualReportId` | prílohy: id, meno, mimeType, veľkosť, počet strán |
| `ruz_download_attachment` | `attachmentId`, `savePath?` | PDF ako base64, alebo uloženie na disk (návrat cesty) |

Pozn.: `ruz_get_statement` a `ruz_list_statements` ostávajú oddelené (list = prehľad
naprieč rokmi, get = detail jednej). Akceptované v review.

## 5. Normalizácia a slovník ukazovateľov

**Prístup (schválený):** kotvenie na **štatutárne číslo riadku** + slovník ukazovateľov
podľa rodiny šablón. Pre každý ukazovateľ je definované, v ktorej tabuľke a na ktorom
štatutárnom čísle riadku sedí, zvlášť pre rodiny:
- **Úč POD** — podvojné účtovníctvo (malá / veľká účtovná jednotka),
- **Úč MÚJ** — mikro účtovná jednotka,
- **JÚ** — jednoduché účtovníctvo (ak prítomné).

Šablóna sa načíta raz (cache), zmapuje sa `index → číslo riadku`, hodnota sa číta zo
stĺpca „Bežné účtovné obdobie" (netto, ak relevantné).

**Slovník ukazovateľov (6, schválené):**
1. Tržby (z predaja tovaru + vlastných výrobkov a služieb)
2. Výsledok hospodárenia za účtovné obdobie po zdanení
3. Vlastné imanie
4. Aktíva spolu (SPOLU MAJETOK)
5. Záväzky spolu
6. Zadlženosť (odvodené: záväzky / aktíva)

Každý ukazovateľ vracia hodnotu, rok, menu a zdroj (číslo riadku). Ak sa ukazovateľ
v danej šablóne nenájde, vráti `null` s dôvodom — nikdy sa nehádže odhad.

**Robustnosť oproti alternatívam:**
- Mapovanie podľa textu názvu riadku — krehké (diakritika, varianty). Použité len ako
  sekundárna validácia.
- Natvrdo indexy buniek — praskne pri novej šablóne. Nepoužité.

## 6. Ošetrenie hrán

| Situácia | Správanie |
|---|---|
| Prázdny `obsah` (IFRS, banky, oznámenia) | `structured_data_unavailable: true` + odkaz na `ruz_download_attachment`; žiadne vymyslené čísla |
| `stav: NEVEREJNÁ` / `ZMAZANÉ` | vráti stav, žiadne dáta |
| Neznáma/cudzia šablóna | fallback na plný výpis riadkov bez mapovania ukazovateľov |
| Konsolidovaná vs individuálna | explicitne odlíšené; `ruz_financial_profile` defaultne preferuje individuálnu (DD), `consolidated=true` prepne |
| IČO bez jednotky / viac jednotiek | vráti prázdny zoznam, resp. všetky nájdené ID |
| Výpadok / timeout API | typovaná chyba s HTTP stavom, žiadne tiché zlyhanie |

## 7. Testovanie

- **Unit (`financials`):** fixture výkazy Úč POD (malá/veľká), Úč MÚJ (mikro) +
  zodpovedajúce šablóny → overenie extrakcie 6 ukazovateľov a zostavenia trendu.
- **Edge unit:** prázdny `obsah` → `structured_data_unavailable`; neznáma šablóna → fallback.
- **Live (`*.live.test.ts`):** proti reálnemu API — ESET individuálna (naplnený obsah),
  jedna mikro s.r.o., jedna IFRS jednotka (overenie PDF fallbacku). Spúšťané manuálne.

## 8. Transport a nasadenie

Identické s ORSR-MCP: `npm run start` (stdio, tsx), `npm run start:http`
(StreamableHTTP), `npm run build` (tsc), `npm run start:prod` (node dist).
Registrácia v klientovi ako stdio: `node /…/RUZ-MCP/dist/server.js`.

## 9. Mimo rozsahu (YAGNI)

- Vyhľadávanie podľa názvu, OAuth, perzistentná DB, watchlist monitoring,
  EBITDA/likvidita/rentabilita/počet zamestnancov (môžu pribudnúť neskôr rozšírením
  slovníka ukazovateľov), webové UI, integrácia do SK-DD agregátora (samostatný projekt).
