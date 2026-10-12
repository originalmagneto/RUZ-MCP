# RÚZ: prihlasovanie SKALLARS

Dizajn prevzatý 12. 10. 2026 zo ZRSR-MCP, ktorý používa lokálny snapshot návrhu Kataster / SKALLARS. Font General Sans, logo, flow pattern, CSS a JavaScript sa obsluhujú z `/assets` bez externých služieb. Docker balí adresár `public`.

Formuláre používajú existujúce OAuth heslo a jednorazový súhlas pre službu Register účtovných závierok. Zachovávajú PKCE, session cookies, návratové údaje a ochranu proti opakovaným pokusom. Nepridávajú spoločné účty ani obnovu hesla. Dynamické hodnoty sa escapujú, heslo sa nikdy nevracia v HTML a CSP nepovoľuje inline skripty ani štýly.

Táto zmena nevyžaduje migráciu tokenov, zmenu hesiel, environment premenných ani persistentného store. Nasadenie je samostatný krok.
