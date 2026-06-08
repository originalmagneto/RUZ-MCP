import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRuzMcpServer } from "./mcp-server.js";

async function main() {
  const server = createRuzMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("ruz-mcp stdio fatal:", err);
  process.exit(1);
});
