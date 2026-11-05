# komodo-mcp

A private MCP server that lets Claude manage Komodo: list and inspect resources, read logs,
deploy, run builds and procedures, change config, and (optionally) run shell commands.

It uses Komodo's official `komodo_client` package and the official MCP TypeScript SDK.
Dependencies are pinned to exact versions.

## Tools

| Tool | What it does | Guarded by |
| --- | --- | --- |
| `komodo_describe` | Shows the parameters and docs of any Komodo API call, or lists all of them | — |
| `komodo_read` | Any of Komodo's 140 read calls (`ListStacks`, `GetStackLog`, `ListUpdates`, ...) | — |
| `komodo_execute` | Any of the 79 execute calls (`DeployStack`, `RunBuild`, `RunProcedure`, ...). Waits for the job and returns its logs | Destructive calls need `KOMODO_MCP_ALLOW_DESTRUCTIVE` |
| `komodo_write` | Any of the 114 write calls (create/update/rename resources, variables, tags, ...) | Deletes and user/permission/key/secret changes need `KOMODO_MCP_ALLOW_DESTRUCTIVE` |
| `komodo_exec` | Shell command on a server, container, deployment or stack service | Needs `KOMODO_MCP_ALLOW_EXEC` |

"Destructive" means Destroy, Delete, Prune, Remove, Stop, Rotate and Clear calls, `RunSync`,
`GlobalAutoUpdate`, `BackupCoreDatabase`, and any write that touches users, permissions, API keys,
onboarding keys, git/registry accounts or secret variables. See `src/policy.ts`.

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `KOMODO_URL` | required | Komodo Core address |
| `KOMODO_API_KEY` / `KOMODO_API_KEY_FILE` | required | API key, or a file containing it |
| `KOMODO_API_SECRET` / `KOMODO_API_SECRET_FILE` | required | API secret, or a file containing it |
| `KOMODO_MCP_READ_ONLY` | `false` | Only allow `komodo_describe` and `komodo_read` |
| `KOMODO_MCP_ALLOW_DESTRUCTIVE` | `false` | Allow destructive execute/write calls |
| `KOMODO_MCP_ALLOW_EXEC` | `false` | Allow `komodo_exec` |
| `KOMODO_MCP_EXEC_TIMEOUT_MS` | `120000` | Timeout for `komodo_exec` |

The API key's Komodo permissions are the real limit: the server can never do more than the key's user.

## Build

```bash
npm ci
npm run build
```

## Add to Claude Code

Create an API key in Komodo (Settings → Users → your service user → API Keys), then run this
in your own terminal so the secret stays out of chat and out of git:

```bash
claude mcp add komodo -s user \
  -e KOMODO_URL=https://your-komodo-host \
  -e KOMODO_API_KEY=your-key \
  -e KOMODO_API_SECRET=your-secret \
  -- node /path/to/komodo-mcp/dist/index.js
```

Add `-e KOMODO_MCP_ALLOW_DESTRUCTIVE=true` and/or `-e KOMODO_MCP_ALLOW_EXEC=true` for full control.
Claude Code asks before each tool call unless you allow the tool, so keep `komodo_execute`,
`komodo_write` and `komodo_exec` off your allowlist if you want to approve every change.

## Upgrading komodo_client

```bash
npm i komodo_client@<version>
npm run build   # regenerates src/generated/api.ts from the new version
```
