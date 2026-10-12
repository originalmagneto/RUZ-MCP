import { describe, expect, test } from "vitest";
import { renderLoginPage, renderConsentPage } from "../src/auth-ui.js";
describe("SKALLARS auth presentation", () => {
  test("keeps the password gate contract and uses the shared local design", () => {
    const html = renderLoginPage({ ticket: "safe-return" });
    expect(html).toContain('action="/oauth/login"');
    expect(html).toContain('name="ticket" value="safe-return"');
    expect(html).toContain('<label for="password">Autorizačné heslo</label>');
    expect(html).toContain('autocomplete="current-password"');
    expect(html).toContain('data-reveal="password"');
    expect(html).toContain("/assets/auth.css");
    expect(html).toContain("/assets/logo.svg");
    expect(html).toContain("Register účtovných závierok");
    expect(html).not.toContain('name="username"');
    expect(html).not.toContain("SKALLARS účet");
    expect(html).not.toContain("style=");
    expect(html).not.toMatch(/https?:\/\//);
  });
  test("escapes dynamic attributes and errors and never reflects a password", () => {
    const html = renderLoginPage({
      ticket: '" onfocus="alert(1)',
      error: "<script>bad</script>",
    });
    expect(html).not.toContain("<script>bad</script>");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="auth-error"');
    expect(html).not.toContain('onfocus="alert(1)');
    expect(html).not.toMatch(/name="password"[^>]*value=/);
  });
  test("preserves explicit OAuth consent and escapes client-supplied metadata", () => {
    const html = renderConsentPage({
      nonce: 'nonce"unsafe',
      clientId: "<script>client</script>",
      redirectUri: "https://client.example/?q=<evil>",
      scopes: "mcp:read mcp:tools",
    });
    expect(html).toContain('action="/oauth/consent"');
    expect(html).toContain('name="nonce" value="nonce&quot;unsafe"');
    expect(html).toContain('name="decision" value="allow"');
    expect(html).toContain('name="decision" value="deny"');
    expect(html).toContain("&lt;script&gt;client&lt;/script&gt;");
    expect(html).toContain("https://client.example/?q=&lt;evil&gt;");
    expect(html).toContain("mcp:read mcp:tools");
    expect(html).not.toContain("90 dní");
  });
});
