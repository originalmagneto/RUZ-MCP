import { describe, expect, it } from "vitest";
import { loadRuzOAuthConfig } from "../src/oauth-config.js";

const base = {
  OAUTH_ISSUER_URL: "https://ruz.example.test",
  OAUTH_TOKEN_STORE_PATH: "/data/oauth.json",
  OAUTH_AUTHORIZATION_PASSWORD: "dostatocne-dlhe-heslo",
} as NodeJS.ProcessEnv;

describe("RÚZ OAuth konfigurácia", () => {
  it("prijme kompletnú konfiguráciu", () => {
    const config = loadRuzOAuthConfig(base);
    expect(config.issuerUrl).toBe("https://ruz.example.test");
    expect(config.scopes).toEqual(["mcp:tools"]);
    expect(config.enableDcr).toBe(true);
  });

  it("bez autorizačného hesla nenabehne", () => {
    expect(() => loadRuzOAuthConfig({ ...base, OAUTH_AUTHORIZATION_PASSWORD: undefined }))
      .toThrow(/OAUTH_AUTHORIZATION_PASSWORD/);
  });

  it("odmietne krátke heslo, aby brána nebola len na oko", () => {
    expect(() => loadRuzOAuthConfig({ ...base, OAUTH_AUTHORIZATION_PASSWORD: "kratke" }))
      .toThrow(/at least 16 characters/);
  });

  it("bez durable úložiska nenabehne, inak by tokeny zmizli pri reštarte", () => {
    expect(() => loadRuzOAuthConfig({ ...base, OAUTH_TOKEN_STORE_PATH: undefined }))
      .toThrow(/OAUTH_TOKEN_STORE_PATH/);
  });

  it("vyžaduje https issuer", () => {
    expect(() => loadRuzOAuthConfig({ ...base, OAUTH_ISSUER_URL: "http://ruz.example.test" }))
      .toThrow(/https/);
  });

  it("odmietne neplatný scope", () => {
    expect(() => loadRuzOAuthConfig({ ...base, OAUTH_SCOPES: "mcp:tools zlý scope!" }))
      .toThrow(/scope/i);
  });

  it("odmietne nezmyselné TTL", () => {
    expect(() => loadRuzOAuthConfig({ ...base, OAUTH_ACCESS_TOKEN_TTL_SECONDS: "0" }))
      .toThrow(/positive/);
  });
});
