#!/usr/bin/env node
// Komodo MCP server: lets Claude (or any MCP client) call the Komodo API.
// Talks stdio, so the client starts it as a subprocess. Logs go to stderr only.
import "./polyfills.js"; // must stay first
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { KomodoClient, Types } from "komodo_client";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { findDefinition } from "./describe.js";
import { EXECUTE_REQUESTS, KOMODO_CLIENT_VERSION, READ_REQUESTS, WRITE_REQUESTS } from "./generated/api.js";
import { ALLOW_DESTRUCTIVE, ALLOW_EXEC, READ_ONLY, isDestructive } from "./policy.js";

const MAX_OUTPUT = 60_000; // characters returned to the model per call
const EXEC_TIMEOUT_MS = Number(process.env.KOMODO_MCP_EXEC_TIMEOUT_MS ?? 120_000);

// ---------- Komodo connection ----------

function env(name: string): string | undefined {
  const v = process.env[name]?.trim();
  return v ? v : undefined;
}

/** Reads NAME, or the contents of the file at NAME_FILE (for Docker secrets etc.). */
function fileEnv(name: string): string | undefined {
  const path = env(`${name}_FILE`);
  return path ? readFileSync(path, "utf8").trim() : env(name);
}

const url = env("KOMODO_URL");
const key = fileEnv("KOMODO_API_KEY");
const secret = fileEnv("KOMODO_API_SECRET");
if (!url || !key || !secret) {
  console.error("komodo-mcp: set KOMODO_URL, KOMODO_API_KEY and KOMODO_API_SECRET (or *_FILE variants).");
  process.exit(1);
}
const komodo = KomodoClient(url.replace(/\/+$/, ""), { type: "api-key", params: { key, secret } });

// ---------- helpers ----------

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  let text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  if (text === undefined) text = "OK (no content)";
  if (text.length > MAX_OUTPUT) {
    text = text.slice(0, MAX_OUTPUT) +
      `\n\n[truncated: ${text.length - MAX_OUTPUT} more characters. Narrow the query, e.g. use a filter, a smaller "tail", or a single resource.]`;
  }
  return { content: [{ type: "text", text }] };
}

function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function errorText(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as any;
    // komodo_client throws { status, result: { error, trace } }
    if (anyE.result?.error) return `Komodo error (HTTP ${anyE.status ?? "?"}): ${anyE.result.error}` +
      (Array.isArray(anyE.result.trace) && anyE.result.trace.length ? `\n${anyE.result.trace.join("\n")}` : "");
    if (anyE.message) return String(anyE.message);
  }
  try { return JSON.stringify(e); } catch { return String(e); }
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try { return ok(await fn()); } catch (e) { return fail(errorText(e)); }
}

function blocked(kind: "execute" | "write", type: string): ToolResult | undefined {
  if (READ_ONLY) return fail(`Blocked: this server runs with KOMODO_MCP_READ_ONLY=true, so "${type}" is not allowed.`);
  if (isDestructive(kind, type) && !ALLOW_DESTRUCTIVE) {
    return fail(`Blocked: "${type}" is destructive or touches users/keys/secrets. ` +
      `Ask the user to do it in the Komodo UI, or to restart this server with KOMODO_MCP_ALLOW_DESTRUCTIVE=true.`);
  }
  return undefined;
}

const params = z.record(z.string(), z.unknown()).default({})
  .describe('Request parameters, e.g. {"stack": "my-stack"}. Call komodo_describe first if unsure of the fields.');

// ---------- server ----------

const server = new McpServer({ name: "komodo-mcp", version: "0.1.0" });

server.registerTool("komodo_describe", {
  title: "Describe a Komodo API call",
  description:
    "Show the parameter definition (with docs) of a Komodo API request or type, e.g. 'DeployStack', 'ListStacks', 'GetStackLog'. " +
    "Use this before komodo_read/komodo_execute/komodo_write when you are not sure of the params. " +
    "Without a name, lists every available request name.",
  inputSchema: { name: z.string().optional().describe("Request or type name, e.g. 'DeployStack'") },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ name }) => {
  if (!name) {
    return ok({
      komodo_client: KOMODO_CLIENT_VERSION,
      read: READ_REQUESTS, execute: EXECUTE_REQUESTS, write: WRITE_REQUESTS,
      destructive_allowed: ALLOW_DESTRUCTIVE, exec_allowed: ALLOW_EXEC, read_only: READ_ONLY,
    });
  }
  const def = findDefinition(name);
  if (!def) return fail(`No request or type named "${name}". Call komodo_describe without a name to list them.`);
  const kind = (READ_REQUESTS as readonly string[]).includes(name) ? "read"
    : (EXECUTE_REQUESTS as readonly string[]).includes(name) ? "execute"
    : (WRITE_REQUESTS as readonly string[]).includes(name) ? "write" : "type";
  const note = kind === "type" ? "" :
    `Use with komodo_${kind}.` + (kind !== "read" && isDestructive(kind, name) ? " Destructive: needs KOMODO_MCP_ALLOW_DESTRUCTIVE=true." : "");
  return ok(`${def}\n\n${note}`.trim());
});

server.registerTool("komodo_read", {
  title: "Read from Komodo",
  description:
    "Run a read-only Komodo API request. Common ones: ListServers, ListStacks, ListDeployments, ListBuilds, ListProcedures, " +
    "GetStack, GetDeployment, GetStackLog {stack, services?, tail}, GetDeploymentLog {deployment, tail}, " +
    "ListDockerContainers {server}, GetSystemStats {server}, ListUpdates {query?, page?}, GetUpdate {id}, ListAlerts.",
  inputSchema: { type: z.enum(READ_REQUESTS), params },
  annotations: { readOnlyHint: true, openWorldHint: true },
}, async ({ type, params }) => run(() => (komodo.read as any)(type, params)));

server.registerTool("komodo_execute", {
  title: "Run a Komodo action",
  description:
    "Run a Komodo execute request (deploy, pull, start, restart, run build/procedure/action, ...). " +
    "By default waits until the job finishes and returns the final Update with its logs. " +
    "Destroy/Delete/Prune/Remove/Stop/Rotate calls are blocked unless the server allows destructive actions.",
  inputSchema: {
    type: z.enum(EXECUTE_REQUESTS),
    params,
    wait: z.boolean().default(true).describe("Wait for completion and return the final Update (default true)."),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ type, params, wait }) => {
  const stop = blocked("execute", type);
  if (stop) return stop;
  return run(() => wait ? (komodo.execute_and_poll as any)(type, params) : (komodo.execute as any)(type, params));
});

server.registerTool("komodo_write", {
  title: "Change Komodo configuration",
  description:
    "Run a Komodo write request: create/update/copy/rename resources (stacks, deployments, builds, repos, procedures, " +
    "variables, tags, ...). Delete calls and anything touching users, permissions, API keys or secrets are blocked " +
    "unless the server allows destructive actions.",
  inputSchema: { type: z.enum(WRITE_REQUESTS), params },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async ({ type, params }) => {
  const stop = blocked("write", type);
  if (stop) return stop;
  return run(() => (komodo.write as any)(type, params));
});

server.registerTool("komodo_exec", {
  title: "Run a shell command via Komodo",
  description:
    "Run a shell command on a Komodo server, inside a container, a deployment's container, or a stack service. " +
    "Disabled unless the server is started with KOMODO_MCP_ALLOW_EXEC=true. Returns the output and exit code.",
  inputSchema: {
    target: z.enum(["server", "container", "deployment", "stack"]),
    server: z.string().optional().describe("Server id or name (target=server or container)"),
    container: z.string().optional().describe("Container name (target=container)"),
    deployment: z.string().optional().describe("Deployment id or name (target=deployment)"),
    stack: z.string().optional().describe("Stack id or name (target=stack)"),
    service: z.string().optional().describe("Compose service name (target=stack)"),
    command: z.string().min(1),
    shell: z.string().default("sh").describe("Shell inside containers, e.g. sh or bash"),
  },
  annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
}, async (a) => {
  if (READ_ONLY || !ALLOW_EXEC) {
    return fail("Blocked: shell exec is disabled. Restart this server with KOMODO_MCP_ALLOW_EXEC=true to enable it.");
  }
  const need = (field: keyof typeof a) => {
    if (!a[field]) throw new Error(`"${String(field)}" is required for target=${a.target}`);
    return a[field] as string;
  };

  const lines: string[] = [];
  let size = 0;
  let exitCode: string | undefined;
  const callbacks = {
    onLine: (line: string) => {
      size += line.length + 1;
      if (size <= MAX_OUTPUT) lines.push(line);
    },
    onFinish: (code: string) => { exitCode = code; },
  };
  const terminal = "claude-mcp";
  const recreate = Types.TerminalRecreateMode.Always;

  try {
    const job = (() => {
      switch (a.target) {
        case "server":
          return komodo.execute_server_terminal(
            { server: need("server"), terminal, command: a.command, init: { command: a.shell, recreate } }, callbacks);
        case "container":
          return komodo.execute_container_exec(
            { server: need("server"), container: need("container"), shell: a.shell, command: a.command, terminal, recreate }, callbacks);
        case "deployment":
          return komodo.execute_deployment_exec(
            { deployment: need("deployment"), shell: a.shell, command: a.command, terminal, recreate }, callbacks);
        case "stack":
          return komodo.execute_stack_exec(
            { stack: need("stack"), service: need("service"), shell: a.shell, command: a.command, terminal, recreate }, callbacks);
      }
    })();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${EXEC_TIMEOUT_MS} ms`)), EXEC_TIMEOUT_MS);
    });
    try { await Promise.race([job, timeout]); } finally { clearTimeout(timer); }
  } catch (e) {
    return fail(`${errorText(e)}${lines.length ? `\n\nOutput so far:\n${lines.join("\n")}` : ""}`);
  }
  const truncated = size > MAX_OUTPUT ? `\n[output truncated at ${MAX_OUTPUT} characters]` : "";
  return { content: [{ type: "text", text: `${lines.join("\n")}${truncated}\n\n[exit code: ${exitCode ?? "unknown"}]` }],
    isError: exitCode !== undefined && exitCode !== "0" };
});

await server.connect(new StdioServerTransport());
console.error(`komodo-mcp ready (${url}; read_only=${READ_ONLY}, destructive=${ALLOW_DESTRUCTIVE}, exec=${ALLOW_EXEC})`);
