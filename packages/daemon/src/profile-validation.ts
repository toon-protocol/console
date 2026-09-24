/**
 * Validating what a person types into a network profile (TOON_Network#150).
 *
 * Only endpoints are ever accepted here — no chain id, token address or
 * settlement address, exactly the rule `profiles.ts` states and
 * `profiles.test.ts` enforces for the built-ins. This module is the same
 * rule applied to whatever a person adds: it has no idea what a chain fact
 * looks like, only what an endpoint's URL shape is allowed to be, so there is
 * nowhere in it a chain fact could even be typed in and accepted.
 *
 * **The insecure-scheme rule.** `http://`/`ws://` is refused everywhere
 * except:
 * - a **loopback host** (`localhost`, `127.0.0.0/8`, `::1`) — the address a
 *   docker sandbox or a hand-rolled devnet fork actually listens on, where
 *   TLS would be a certificate nobody could issue; or
 * - a profile that is **sandbox-like**, meaning its id is the built-in
 *   `sandbox`'s (overriding it, endpoint by endpoint, is the point — see
 *   `profile-store.ts` — and its whole reason to exist is a docker network
 *   this machine trusts by construction, not by certificate).
 *
 * Every other profile — devnet, mainnet, and anything a person adds under a
 * new id — talks to a network this console does not otherwise trust, so its
 * connector, relay, gateway, gas station, faucet and RPC endpoints all have
 * to carry a scheme that authenticates the far end.
 */

import { SANDBOX } from './profiles.js';

const HTTP_SCHEMES = ['http:', 'https:'];
const WS_SCHEMES = ['ws:', 'wss:'];
const RPC_SCHEMES = [...HTTP_SCHEMES, ...WS_SCHEMES];
const SECURE_SCHEMES = new Set(['https:', 'wss:']);

/** A profile id is only ever used to name a directory (`paths.ts`'s
 * `profileDataDir`), so it is checked the same way `safeKey` checks a
 * pubkey: a fixed, safe alphabet, never whatever a request body happened to
 * contain. Lowercase so a path never differs by case alone. */
const ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/u;

export function isValidProfileId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** Every endpoint field a profile can carry, and the label a request body
 * uses for each — `rpc.evm`/`rpc.solana` name the nested pair. Order here is
 * the order errors and overridden-field lists are reported in. */
export const ENDPOINT_FIELD_NAMES = [
  'connectorUrl',
  'relayUrl',
  'gatewayDomain',
  'gatewayConnectorUrl',
  'gasConnectorUrl',
  'faucetUrl',
  'rpc.evm',
  'rpc.solana',
] as const;

export type EndpointFieldName = (typeof ENDPOINT_FIELD_NAMES)[number];

/** The shape a `PUT /api/profiles/<id>` body's endpoints arrive in — every
 * field optional, since a person overrides whichever subset they touch. */
export interface ProfileEndpointInput {
  readonly connectorUrl?: string | undefined;
  readonly relayUrl?: string | undefined;
  readonly gatewayDomain?: string | undefined;
  readonly gatewayConnectorUrl?: string | undefined;
  readonly gasConnectorUrl?: string | undefined;
  readonly faucetUrl?: string | undefined;
  readonly rpc?:
    | {
        readonly evm?: string | undefined;
        readonly solana?: string | undefined;
      }
    | undefined;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[/u, '').replace(/\]$/u, '');
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.startsWith('127.')
  );
}

/** Whether `http://`/`ws://` needs no upgrade for this profile — see the
 * module doc comment's "insecure-scheme rule". */
export function isSandboxLike(profileId: string): boolean {
  return profileId === SANDBOX.id;
}

function validateUrlField(
  value: string,
  schemes: readonly string[],
  label: string,
  sandboxLike: boolean
): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${label} must be a full URL, e.g. ${schemes[0]}//host.example`;
  }
  if (!schemes.includes(url.protocol)) {
    const names = schemes.map((scheme) => scheme.replace(':', '')).join(' or ');
    return `${label} must start with ${names}://`;
  }
  if (!SECURE_SCHEMES.has(url.protocol) && !isLoopbackHost(url.hostname) && !sandboxLike) {
    const secure = schemes.filter((scheme) => SECURE_SCHEMES.has(scheme));
    return `${label} must use ${secure.map((scheme) => scheme.replace(':', '')).join(' or ')} unless it points at loopback.`;
  }
  return undefined;
}

/** `gatewayDomain` is a bare hostname suffix, never a URL: no scheme, no
 * path, an optional `:port`. */
function validateGatewayDomain(value: string): string | undefined {
  if (/:\/\//u.test(value) || value.includes('/')) {
    return 'the gateway domain is a hostname, not a URL — no scheme or path.';
  }
  const HOSTNAME =
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[0-9]{1,5})?$/iu;
  if (!HOSTNAME.test(value)) {
    return 'the gateway domain must be a hostname, optionally with a port.';
  }
  return undefined;
}

/**
 * Validates every non-empty field of `input`, per field — an empty or
 * whitespace-only value is never an error, because it means "no override for
 * this field," not "the endpoint is the empty string" (`profile-store.ts`
 * drops it the same way before it is ever stored).
 *
 * Returns a `{ field: message }` map, `field` spelled exactly as
 * {@link ENDPOINT_FIELD_NAMES} does — empty when everything given is valid.
 */
export function validateProfileEndpoints(
  input: ProfileEndpointInput,
  options: { readonly sandboxLike: boolean }
): Record<string, string> {
  const errors: Record<string, string> = {};
  const { sandboxLike } = options;

  const check = (field: string, value: string | undefined, message: string | undefined) => {
    if (value === undefined || value.trim().length === 0) return;
    if (message !== undefined) errors[field] = message;
  };

  check(
    'connectorUrl',
    input.connectorUrl,
    input.connectorUrl === undefined
      ? undefined
      : validateUrlField(
          input.connectorUrl.trim(),
          HTTP_SCHEMES,
          'the connector URL',
          sandboxLike
        )
  );
  check(
    'relayUrl',
    input.relayUrl,
    input.relayUrl === undefined
      ? undefined
      : validateUrlField(input.relayUrl.trim(), WS_SCHEMES, 'the relay URL', sandboxLike)
  );
  check(
    'gatewayDomain',
    input.gatewayDomain,
    input.gatewayDomain === undefined
      ? undefined
      : validateGatewayDomain(input.gatewayDomain.trim())
  );
  check(
    'gatewayConnectorUrl',
    input.gatewayConnectorUrl,
    input.gatewayConnectorUrl === undefined
      ? undefined
      : validateUrlField(
          input.gatewayConnectorUrl.trim(),
          HTTP_SCHEMES,
          "the gateway's connector URL",
          sandboxLike
        )
  );
  check(
    'gasConnectorUrl',
    input.gasConnectorUrl,
    input.gasConnectorUrl === undefined
      ? undefined
      : validateUrlField(
          input.gasConnectorUrl.trim(),
          HTTP_SCHEMES,
          "the gas station's connector URL",
          sandboxLike
        )
  );
  check(
    'faucetUrl',
    input.faucetUrl,
    input.faucetUrl === undefined
      ? undefined
      : validateUrlField(input.faucetUrl.trim(), HTTP_SCHEMES, 'the faucet URL', sandboxLike)
  );
  check(
    'rpc.evm',
    input.rpc?.evm,
    input.rpc?.evm === undefined
      ? undefined
      : validateUrlField(input.rpc.evm.trim(), RPC_SCHEMES, 'the EVM RPC URL', sandboxLike)
  );
  check(
    'rpc.solana',
    input.rpc?.solana,
    input.rpc?.solana === undefined
      ? undefined
      : validateUrlField(
          input.rpc.solana.trim(),
          RPC_SCHEMES,
          'the Solana RPC URL',
          sandboxLike
        )
  );

  return errors;
}
