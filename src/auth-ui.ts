const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );

function page(title: string, subtitle: string, body: string): string {
  return `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title} | RÚZ | SKALLARS</title><link rel="icon" href="data:,"><link rel="stylesheet" href="/assets/tokens.css"><link rel="stylesheet" href="/assets/auth.css"><script src="/assets/auth.js" defer></script></head><body><a class="skip" href="#main">Preskočiť na formulár</a><header class="top"><img class="logo" src="/assets/logo.svg" alt="SKALLARS" width="224" height="42"><span class="top-note">Prístup k pracovným nástrojom</span></header><div class="layout"><aside class="identity" aria-label="Pracovné nástroje SKALLARS"><img class="art" src="/assets/flow.svg" alt="" aria-hidden="true"><h2>Právne nástroje.<br>Pre vašu prax.</h2><p>Register účtovných závierok.<br>V pracovnom prostredí SKALLARS.</p></aside><main id="main" class="form-panel"><div class="service"><span class="dot" aria-hidden="true"></span><strong>Register účtovných závierok</strong><span>Prístup k službe</span></div><h1>${title}</h1><p class="intro">${subtitle}</p>${body}</main></div><footer class="footer"><span>© ${new Date().getFullYear()} SKALLARS</span><span>Pracovné nástroje</span></footer></body></html>`;
}

export function renderLoginPage(options: {
  ticket: string;
  error?: string;
}): string {
  const error = options.error
    ? `<p class="error" id="auth-error" role="alert">${escapeHtml(options.error)}</p>`
    : "";
  return page(
    "Vitajte späť.",
    "Zadajte prístupové heslo k tejto službe.",
    `${error}<form method="post" action="/oauth/login"><input type="hidden" name="ticket" value="${escapeHtml(options.ticket)}"><div class="field"><label for="password">Autorizačné heslo</label><div class="password"><input id="password" name="password" type="password" autocomplete="current-password" required autofocus${options.error ? ' aria-invalid="true" aria-describedby="auth-error"' : ""}><button class="reveal" type="button" data-reveal="password" aria-controls="password" aria-pressed="false">Zobraziť</button></div></div><button class="primary" type="submit"><span>Prihlásiť sa</span><span class="arrow" aria-hidden="true">→</span></button></form><p class="assist">Prístupové heslo vám poskytne správca pracovných nástrojov.</p>`,
  );
}

export function renderConsentPage(options: {
  nonce: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
}): string {
  return page(
    "Povoliť prístup?",
    "Skontrolujte, ku ktorej službe sa aplikácia pripája.",
    `<p>Aplikácia žiada prístup k službe <strong>Register účtovných závierok</strong>.</p><ul class="consent-list"><li><span class="check" aria-hidden="true">↗</span><span>Vyhľadávať účtovné závierky podľa IČO</span></li><li><span class="check" aria-hidden="true">↗</span><span>Čítať finančné profily, výkazy a verejné prílohy</span></li></ul><p class="legal">Aplikácia nedostane vaše heslo. Súhlas platí pre toto pripojenie.</p><details class="details" open><summary>Podrobnosti pripojenia</summary><p>Klient: ${escapeHtml(options.clientId)}</p><p>Návratová adresa: ${escapeHtml(options.redirectUri)}</p><p>Oprávnenia: ${escapeHtml(options.scopes)}</p></details><form method="post" action="/oauth/consent"><input type="hidden" name="nonce" value="${escapeHtml(options.nonce)}"><button class="primary" name="decision" value="allow" type="submit"><span>Povoliť prístup</span><span class="arrow" aria-hidden="true">→</span></button><button class="secondary" name="decision" value="deny" type="submit">Zamietnuť</button></form>`,
  );
}
