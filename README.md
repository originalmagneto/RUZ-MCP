# RÚZ MCP Server

Read-only MCP server pre **[Register účtovných závierok SR](https://www.registeruz.sk)**.
Vracia destilovaný viacročný finančný profil subjektu podľa IČO, plné výkazy a
originálne PDF dokumenty. Pre preverovanie klienta/protistrany (KYC/AML, DD).

## Nástroje

| Tool | Účel |
|---|---|
| `ruz_find_entity` | IČO/DIČ → účtovná jednotka |
| `ruz_financial_profile` | viacročný trend: tržby, VH, vlastné imanie, aktíva, záväzky, zadlženosť |
| `ruz_list_statements` | zoznam účtovných závierok |
| `ruz_get_statement` | detail jednej závierky |
| `ruz_get_report` | plný čitateľný výkaz (súvaha / výkaz ziskov a strát) |
| `ruz_list_annual_reports` | výročné správy |
| `ruz_list_attachments` | PDF prílohy |
| `ruz_download_attachment` | stiahnutie PDF (base64 alebo na disk) |

## Spustenie

```bash
npm install
npm run build
npm run start        # stdio
npm run start:http   # StreamableHTTP na :8790 (/mcp, /healthz)
```

Registrácia ako stdio MCP: `node /path/to/RUZ-MCP/dist/server.js`.

## Reťazenie s ORSR

RÚZ API hľadá len podľa IČO/DIČ. Pre profil podľa názvu najprv použi ORSR-MCP
(názov → IČO) a výsledné IČO posuň do `ruz_financial_profile`.

## Hrany

- IFRS / banky / oznámenia majú prázdny štruktúrovaný obsah → nástroje vrátia
  `structuredDataAvailable: false` a odkážu na PDF prílohu.
- Neverejné jednotky vrátia len `stav`.
