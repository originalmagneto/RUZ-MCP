// Niektorí MCP klienti serializujú skalárne argumenty ako reťazce ("20",
// "false"). Holé z.number()/z.boolean() vtedy odmietnu celé volanie s
// -32602 "expected number, received string".
import { z } from "zod";

/**
 * Boolean, ktorý prijme aj reťazce "true"/"false".
 *
 * ZÁMERNE NIE z.coerce.boolean(): je to obyčajná JS truthiness, takže reťazec
 * "false" by sa stal true a ticho prevrátil príznak, ktorý volajúci nastavil
 * (napr. consolidated by prepol profil na konsolidovanú závierku).
 * Čokoľvek, čo nie je doslovné "true"/"false", validáciu naďalej neprejde.
 *
 * Funkcia, nie zdieľaná konštanta: pri zod 3 prevodník na JSON Schema zhodné
 * inštancie deduplikuje do $ref na súrodenca a klient taký odkaz nerozlúšti.
 * Toto repo je na zod 4, ktorý inlinuje, ale továreň je tu tak či tak správny
 * zvyk — a nestojí nič.
 */
export function looseBoolean() {
  return z.preprocess(
    (v) => (typeof v === "string" ? (v === "true" ? true : v === "false" ? false : v) : v),
    z.boolean(),
  );
}

/**
 * Číslo, ktoré prijme aj reťazcový zápis. Refinements (.int(), .min(), ...)
 * patria na vnútornú schému — z.preprocess vracia ZodEffects, ktoré ich
 * neponúka. Prázdny reťazec nie je nula: z.coerce.number() mapuje "" na 0,
 * čo by pri years ticho zmenilo rozsah profilu.
 */
export function looseNumber(inner: z.ZodNumber = z.number()) {
  return z.preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? Number.NaN : Number(v)) : v),
    inner,
  );
}
