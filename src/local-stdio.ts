import type { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runWithIdentity } from "./skallars-auth.js";

export function bindLocalStdioIdentity(transport: StdioServerTransport): void {
  const onmessage = transport.onmessage;
  transport.onmessage = (...args) => runWithIdentity("local", () => onmessage?.(...args));
}
