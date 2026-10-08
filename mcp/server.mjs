#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

/**
 * The Lab as a tool for agents — the LOCAL bridge (stdio).
 *
 * This file knows no tools. The one truth about the tool catalogue is in the
 * app (`src/lib/mcp/catalog.ts`, served by `POST /api/mcp`); this bridge
 * PASSES THROUGH: `tools/list` and `tools/call` go as JSON-RPC over HTTP to
 * `${EXAMPLELAB_URL}/api/mcp` with the key from `EXAMPLELAB_API_KEY`.
 *
 * Why it exists: Claude Desktop and Claude Code speak MCP over stdio, not
 * over an address. HorAIzon takes the HTTP address directly.
 *
 *   EXAMPLELAB_URL         base URL of the instance (default http://localhost:3390)
 *   EXAMPLELAB_API_KEY     required; key from Settings → API keys
 *   EXAMPLELAB_TIMEOUT_MS  per call, default 15000
 *
 * stdout belongs to the transport. Everything for humans goes to stderr.
 */

const API_URL = (process.env.EXAMPLELAB_URL ?? "http://localhost:3390").replace(/\/+$/, "");
const API_KEY = process.env.EXAMPLELAB_API_KEY;
const TIMEOUT_MS = Number(process.env.EXAMPLELAB_TIMEOUT_MS) || 15_000;
const ENDPOINT = `${API_URL}/api/mcp`;
const LIST_ONLY = process.argv.includes("--list");

if (!API_KEY) {
  process.stderr.write("[examplelab-mcp] EXAMPLELAB_API_KEY is not set. Create a key under Settings.\n");
  process.exit(1);
}

let nextId = 1;

/**
 * One JSON-RPC message. `tools/list` is retried on network errors, 429 and
 * 5xx. `tools/call` is NEVER retried: a timeout does not mean the call did
 * not happen, and a second `create_note` is a duplicate.
 */
async function rpc(method, params) {
  const attempts = method === "tools/list" ? 3 : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "x-api-key": API_KEY,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return evaluate(await readBody(res));
      const error = new Error(`HTTP ${res.status}: ${shorten(await res.text())}`);
      error.final = res.status !== 429 && res.status < 500;
      throw error;
    } catch (error) {
      if (error?.final) throw error;
      lastError = error;
    }
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 300 * attempt));
  }
  throw lastError ?? new Error(`${ENDPOINT} was not reachable.`);
}

async function readBody(res) {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (res.status === 202 || text.trim().length === 0) return null;
  if (type.includes("text/event-stream")) {
    const data = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    const last = data[data.length - 1];
    return last ? JSON.parse(last) : null;
  }
  return JSON.parse(text);
}

function evaluate(message) {
  if (message && message.error) {
    const error = new Error(message.error.message ?? `JSON-RPC error ${message.error.code}`);
    error.final = true;
    throw error;
  }
  return message?.result ?? {};
}

function shorten(text, limit = 500) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

if (LIST_ONLY) {
  try {
    const result = await rpc("tools/list");
    for (const tool of result.tools ?? []) process.stdout.write(`${tool.name}\n`);
    process.exit(0);
  } catch (error) {
    process.stderr.write(`[examplelab-mcp] tools/list at ${ENDPOINT} failed: ${error?.message ?? String(error)}\n`);
    process.exit(1);
  }
}

const server = new Server({ name: "examplelab", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await rpc("tools/list");
  return { tools: result.tools ?? [] };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    return await rpc("tools/call", { name, arguments: args ?? {} });
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: `Error in ${name}: ${error?.message ?? String(error)}` }] };
  }
});

await server.connect(new StdioServerTransport());
process.stderr.write(`[examplelab-mcp] ready, talking to ${ENDPOINT}.\n`);
