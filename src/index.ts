#!/usr/bin/env node

// Local install: every tool over stdio, credentials from the environment.
// The hosted deployment uses the same server over HTTP (see http.ts).

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createInsumerServer } from "./server.js";

async function main() {
  const { server, warnings } = createInsumerServer({
    apiKey: process.env.INSUMER_API_KEY,
    paymentKey: process.env.INSUMER_PAYMENT_KEY,
    maxPaymentUsdc: process.env.INSUMER_MAX_PAYMENT_USDC,
  });
  for (const w of warnings) console.error(w);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
