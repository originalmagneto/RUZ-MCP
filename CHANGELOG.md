# Changelog

## 0.2.0 — 2026-10-12

Opravy podľa auditu z 9. 10. 2026. Regresné testy (`tests/audit-2026-10-09.test.ts`) bežia nad
odpoveďami zachytenými z RÚZ API (`tests/fixtures/api`, fyzické osoby anonymizované).

### Opravené
- **Tržby na Úč POD od 2014 (šablóna 699).** `revenue` sčítal iba r. 03 (tovar) a vynechal
  r. 04 (vlastné výrobky) a r. 05 (služby). Servisná firma nemala tržby vôbec a obchodníkovi
  chýbali služby. Teraz sa sčítajú tovar + výrobky + služby na všetkých podporovaných šablónach.
  Riadok, ktorý zodpovedá dvom vzorom, sa započíta raz. Nové pole `rows` uvádza všetky sčítané riadky.
- **Výber účtovnej jednotky.** Profil a zoznamy brali prvé id pre IČO. Každý `stav` označili ako
  „Neverejná jednotka", aj keď išlo o zmazaný záznam, takže živé jednotky zostali skryté.
  Zmazané záznamy sa teraz preskakujú a `ZMAZANÉ` sa rozlišuje od `Neverejná`. Pri viacerých
  živých jednotkách sa vráti `ambiguous: true` a `candidates`. Zoznam id sa stránkuje podľa
  `existujeDalsieId`.
- **Duplicitné roky.** Profil vracia jeden riadok za účtovné obdobie, `years` je počet období.
  Čísla sú zo závierky so štruktúrovanými dátami, pri zhode z najneskôr podanej. Riadok má
  `statementId`, `typ`, `datumPodania`, `datumSchvalenia`. Ostatné závierky za obdobie sú
  v `otherStatements` a `note` uvádza pravidlo výberu.
- **`templateName` a `attachmentHint`.** `templateName` je šablóna výkazu, z ktorého sú čísla,
  a nie prvého výkazu (pri závierkach 2009–2013 sú súvaha a výsledovka spojené „ + “). `templateNames` uvádza všetky výkazy. Nápoveda sa určuje z celej závierky
  v poradí IFRS > VÚ POD > správa/oznámenie a pri výkazoch s `pristupnostDat: Neverejné`
  povie, že RÚZ nezverejňuje ani PDF.
- **IFRS filery.** Keď žiadny rok nemá štruktúrované dáta, `note` profilu výslovne povie, že
  `available: false` nie je nula a čísla sú len v PDF.

### Zmenené (výstup)
- `entity.velkost` a `entity.pravnaForma` obsahujú text z číselníkov RÚZ (`/velkosti-organizacie`,
  `/pravne-formy`). Pôvodné kódy sú v nových poliach `velkostKod` a `pravnaFormaKod`. Pri výpadku
  číselníka je text `null` a `codelistNote` to vysvetlí. Pribudli `entityId`, `datumZalozenia`
  a `datumZrusenia`.

### Pridané (vstup)
- `ruz_financial_profile` má voliteľný `entityId` na výber jednej z viacerých jednotiek pod IČO.
