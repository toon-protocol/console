// Forward host secrets INTO the sandcastle Docker sandbox.
//
// WHY THIS EXISTS
// ---------------
// @ai-hero/sandcastle@0.12.0's env resolver does NOT blanket-pass `process.env`
// into the container. It only forwards a variable whose KEY also appears in
// `.sandcastle/.env`. That file is gitignored, so in CI it does not exist, the
// resolved env is empty, and neither token reaches `docker run`. claude-code then
// dies with `Not logged in · Please run /login`, even though the workflow step
// exported CLAUDE_CODE_OAUTH_TOKEN.
//
// THE FIX
// -------
// Pass the secrets through the sandbox provider's first-class `env` option
// (`docker({ env })`), which is baked into the `docker run -e KEY=VALUE` flags at
// container start. Every in-container exec then inherits them: claude-code
// (CLAUDE_CODE_OAUTH_TOKEN) and the in-sandbox `git push` / `gh` calls (GH_TOKEN).
//
// A key is included ONLY when it is set on the host, so a local run whose tokens
// come from `.sandcastle/.env` is not clobbered with an `undefined` override.

// Host env vars that must reach claude-code and `gh`/`git` inside the sandbox.
const PASSTHROUGH_KEYS = [
  'CLAUDE_CODE_OAUTH_TOKEN', // authenticates claude-code
  'GH_TOKEN', // in-sandbox `git push` / `gh` calls
] as const;

// APP_PRIVATE_KEY is DELIBERATELY ABSENT. It stays on the host so the runner can
// mint a fresh push credential (mint-app-token.ts) without the container ever
// holding the key. This repository's Actions logs and artifacts are readable, so
// re-read the redaction step in agent-implement.yml before forwarding anything else.

/**
 * The subset of {@link PASSTHROUGH_KEYS} that is set on the host, as a
 * `Record<string, string>` suitable for `docker({ env })`.
 */
export function sandboxSecrets(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSTHROUGH_KEYS) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}
