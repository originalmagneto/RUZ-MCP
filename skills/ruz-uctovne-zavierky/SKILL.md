---
name: ruz-uctovne-zavierky
description: Použi pri otázkach na finančné výsledky slovenskej firmy podľa IČO — tržby, výsledok hospodárenia, vlastné imanie, aktíva, záväzky, zadlženosť, obsah účtovnej závierky za viac rokov. SK - tržby, výsledok hospodárenia, účtovná závierka, súvaha, výsledovka, vlastné imanie, zadlženosť, bonita, finančný profil firmy. EN - revenue, net profit, financial statements, balance sheet, equity, liabilities, leverage ratio, creditworthiness.
---

# RÚZ — register účtovných závierok

## Načo to je

RÚZ poskladá z uložených účtovných závierok viacročný finančný profil firmy
podľa IČO: tržby, výsledok hospodárenia, vlastné imanie, aktíva, záväzky a
odvodenú zadlženosť. Zdrojom sú otvorené dáta MF SR (registeruz.sk). Server
je iba na čítanie.

## Kedy sem siahnuť

- **Bonita protistrany** pred väčším plnením alebo pred podpisom zmluvy.
- **Due diligence a KYC/AML** — finančný sanity-check počas preverovania.
- **Argumentácia o schopnosti firmy plniť**, napr. pri spore o platobnú
  neschopnosť.
- **Originál závierky** ako PDF, nie len vyťažené čísla.

## Kedy sem nesiahať

| Otázka | Kam namiesto toho |
|---|---|
| Kedy bola závierka podaná, podacie číslo (metadata) | ORSR |
| Kto koná za firmu a ako podpisuje | ORSR |
| Je platiteľ DPH, je daňový dlžník | FS |
| Prebieha konkurz alebo reštrukturalizácia | RU |
| Hľadáš IČO iba podľa názvu firmy | ORSR alebo RPO — tento register hľadá len podľa IČO/DIČ |

## Osvedčené postupnosti

1. Máš iba názov firmy, nie IČO — najprv ho dohľadaj cez ORSR alebo RPO;
   RÚZ API vyhľadávanie podľa názvu nepodporuje.
2. Rýchly viacročný prehľad: `ruz_financial_profile`.
3. Detail konkrétneho roka: `ruz_list_statements` → `ruz_get_statement` →
   `ruz_get_report`.
4. Originál na disk: `ruz_list_attachments` → `ruz_download_attachment`; bez
   `savePath` sa PDF vráti ako base64, čo je pri väčších prílohách zbytočne
   nákladné.

## Pasce

- **`structuredDataAvailable: false`** pri IFRS závierkach, bankách,
  poisťovniach a oznámeniach — vtedy siahni po prílohe cez
  `ruz_list_attachments` a `ruz_download_attachment`, štruktúrované čísla
  tam nie sú.
- **Neverejné jednotky** vrátia iba stav, nič viac.
- **Profil za N rokov znamená N sérií volaní** na RÚZ API — pri veľkých
  firmách to trvá sekundy; zníž `years`, ak potrebuješ rýchlu odpoveď.
- Rate limiting je in-memory na inštanciu; pri viacerých replikách má každá
  vlastný počítadlo.

## Autorizácia

Server beží ako vzdialený MCP cez HTTPS a je chránený OAuth. Pri prvom pripojení
otvorí prehliadač a vyžiada si autorizačné heslo, potom potvrdenie súhlasu.
Heslo je v Dokploy v env premennej `OAUTH_AUTHORIZATION_PASSWORD` daného compose.
