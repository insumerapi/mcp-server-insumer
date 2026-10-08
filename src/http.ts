#!/usr/bin/env node

// Hosted mode: the server over MCP streamable HTTP, one stateless request at a
// time, on a shared API key. Serves the HOSTED_TOOLS subset by default.
//
//   INSUMER_API_KEY=insr_live_... node build/http.js
//
//   PORT                   listen port (default 3000)
//   INSUMER_HOSTED_TOOLS   comma-separated tool names (default: HOSTED_TOOLS)
//   INSUMER_DAILY_CAP      metered calls allowed per UTC day (default 100);
//                          counted in memory here, so one process only. A
//                          multi-instance deployment supplies its own counter
//                          through createInsumerServer({ beforeMeteredCall }).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createInsumerServer, HOSTED_TOOLS, VERSION } from "./server.js";

const PORT = Number(process.env.PORT ?? 3000);
const apiKey = process.env.INSUMER_API_KEY ?? "";
const tools = (process.env.INSUMER_HOSTED_TOOLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const dailyCap = Number(process.env.INSUMER_DAILY_CAP ?? 100);

if (!apiKey) {
  console.error("INSUMER_API_KEY is not set; metered tools will refuse every call.");
}

/** The message a caller sees once the day's shared allowance is used up. */
export const CAP_MESSAGE =
  "This shared endpoint has used its free daily allowance of signed verifications. " +
  "It resets at 00:00 UTC. For your own allowance, create a free API key at " +
  "https://insumermodel.com/developers/ and run the server with it: npx -y mcp-server-insumer";

// In-memory daily counter for the single-process case.
let day = "";
let used = 0;
function countMetered(): string | null {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    used = 0;
  }
  if (used >= dailyCap) return CAP_MESSAGE;
  used += 1;
  return null;
}

const INFO = {
  ok: true,
  service: "InsumerAPI MCP",
  version: VERSION,
  transport: "streamable-http",
  docs: "https://insumermodel.com/developers/",
  tools: tools.length ? tools : [...HOSTED_TOOLS],
};

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const accept = req.headers.accept ?? "";
  // A plain browser or curl GET gets a description; MCP clients send
  // Accept: text/event-stream on GET and are answered by the transport.
  if (req.method === "GET" && !accept.includes("text/event-stream")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(INFO));
    return;
  }
  // Stateless: no server-initiated stream to offer and no session to end. The
  // spec's answer for both is 405; without it a GET stream stays open.
  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json", Allow: "POST" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This server is stateless: send MCP requests with POST." }, id: null }));
    return;
  }

  const { server, warnings } = createInsumerServer({
    apiKey,
    tools: tools.length ? tools : HOSTED_TOOLS,
    beforeMeteredCall: countMetered,
    hideKeyMeta: true,
  });
  for (const w of warnings) console.error(w);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  const body = req.method === "POST" ? await readJson(req) : undefined;
  await transport.handleRequest(req, res, body);
}

createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("Request failed:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
    }
  });
}).listen(PORT, () => {
  console.error(`InsumerAPI MCP (streamable HTTP) listening on :${PORT}, ${INFO.tools.length} tools`);
});
