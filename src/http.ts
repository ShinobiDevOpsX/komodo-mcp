// Streamable HTTP transport for running komodo-mcp as a long-lived service behind a domain.
// Stateless: every POST /mcp gets a fresh MCP server, so nothing is kept between requests.
// Every request to /mcp must carry "Authorization: Bearer <MCP_AUTH_TOKEN>".
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";

const MAX_BODY = 1_000_000; // bytes

export interface HttpOptions {
  createServer: () => McpServer;
  token: string;
  host: string;
  port: number;
}

const digest = (s: string) => createHash("sha256").update(s).digest();

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (message: string) => ({ jsonrpc: "2.0", error: { code: -32000, message }, id: null });

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error("Request body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

export function startHttp({ createServer, token, host, port }: HttpOptions): Promise<void> {
  const expected = digest(`Bearer ${token}`);
  const authorized = (req: IncomingMessage) =>
    timingSafeEqual(digest(req.headers.authorization ?? ""), expected); // hashes keep lengths equal

  const http = createHttpServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;

    if (path === "/healthz" && req.method === "GET") return send(res, 200, { ok: true });
    if (path !== "/mcp") return send(res, 404, { error: "Not found" });

    if (!authorized(req)) {
      return send(res, 401, rpcError("Unauthorized"), { "www-authenticate": 'Bearer realm="komodo-mcp"' });
    }
    // Stateless mode has no server-to-client stream (GET) or session to end (DELETE).
    if (req.method !== "POST") return send(res, 405, rpcError("Method not allowed"), { allow: "POST" });

    let body: unknown;
    try { body = await readBody(req); }
    catch (e) { return send(res, 400, rpcError((e as Error).message)); }

    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      console.error("komodo-mcp: request failed:", e);
      send(res, 500, rpcError("Internal server error"));
    }
  });

  // Long-running tools (komodo_execute with wait, komodo_exec) can take minutes.
  http.requestTimeout = 0;
  http.headersTimeout = 30_000;

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(port, host, () => resolve());
  });
}
