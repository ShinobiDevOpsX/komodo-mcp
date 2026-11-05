// Which Komodo calls count as destructive or sensitive.
// These are blocked unless KOMODO_MCP_ALLOW_DESTRUCTIVE=true.

// Execute calls that stop, remove or wipe things.
const DESTRUCTIVE_EXECUTE =
  /Destroy|Delete|Prune|Remove|Stop|Rotate|Clear|^RunSync$|^GlobalAutoUpdate$|^BackupCoreDatabase$/;

// Write calls that delete things or change users, permissions, keys or secrets.
const DESTRUCTIVE_WRITE =
  /Delete|Remove|Rotate|User|Permission|ApiKey|OnboardingKey|ServerPublicKey|^CommitSync$|IsSecret|GitProviderAccount|ImageRegistryAccount/;

export function isDestructive(kind: "execute" | "write", type: string): boolean {
  return (kind === "execute" ? DESTRUCTIVE_EXECUTE : DESTRUCTIVE_WRITE).test(type);
}

function flag(name: string): boolean {
  return ["1", "true", "yes"].includes((process.env[name] ?? "").toLowerCase());
}

export const ALLOW_DESTRUCTIVE = flag("KOMODO_MCP_ALLOW_DESTRUCTIVE");
export const ALLOW_EXEC = flag("KOMODO_MCP_ALLOW_EXEC");
export const READ_ONLY = flag("KOMODO_MCP_READ_ONLY");
