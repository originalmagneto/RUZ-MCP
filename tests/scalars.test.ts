import { describe, it, expect } from "vitest";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { looseBoolean, looseNumber } from "../src/scalars.js";
import { createRuzMcpServer } from "../src/mcp-server.js";

async function listTools() {
  const server = createRuzMcpServer();
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}

describe("scalar inputs survive a client that stringifies them", () => {
  it("accepts booleans and numbers in string form", () => {
    expect(looseBoolean().parse("true")).toBe(true);
    expect(looseNumber(z.number().int()).parse("7")).toBe(7);
  });

  // z.coerce.boolean() would return true here and silently switch the profile
  // to the consolidated statement, which reports a different company's numbers.
  it('does not read "false" as true', () => {
    expect(looseBoolean().parse("false")).toBe(false);
    expect(looseBoolean().safeParse("ano").success).toBe(false);
  });

  it("does not read an empty string as zero", () => {
    expect(looseNumber().safeParse("").success).toBe(false);
  });

  it("leaves no bare scalar in the tool registrations", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp-server.ts"),
      "utf8",
    );
    expect(src.match(/\w+:\s*z\s*\n?\s*\.(number|boolean)\(\)/g)).toBeNull();
  });

  it("publishes years as a number and consolidated as a boolean", async () => {
    const props = (await listTools()).find((t) => t.name === "ruz_financial_profile")
      ?.inputSchema?.properties as Record<string, { type?: string }> | undefined;
    expect(props?.years?.type).toBe("integer");
    expect(props?.consolidated?.type).toBe("boolean");
  });

  it("publishes no internal $ref", async () => {
    for (const tool of await listTools()) {
      expect(JSON.stringify(tool.inputSchema)).not.toContain("$ref");
    }
  });
});
