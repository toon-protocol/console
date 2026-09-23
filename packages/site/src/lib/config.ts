/**
 * What this build does not decide.
 *
 * `site-config.json` sits beside `index.html` and is fetched at runtime, so
 * the documentation npub and the relay list can change on the box without a
 * rebuild and a redeploy. That matters for exactly one reason: the npub does
 * not exist until somebody mints it (`toon-docs-publish --new-key`), and a
 * site that could only learn it by being rebuilt would have to be rebuilt by
 * whoever held the key.
 *
 * It is also why there is no npub and no relay URL in this package's source.
 * The defaults below are the shape, not the values: an empty npub means "read
 * nothing, show what this build shipped with, and say so".
 */

export interface SiteConfig {
  /** TOON Network's documentation key. Empty until one is minted. */
  readonly docsNpub: string;
  readonly relays: readonly string[];
  /** Which network this site describes. `devnet` today, and it says so. */
  readonly network: string;
  readonly gatewayDomain: string;
  readonly aurPackage: string;
  readonly repoUrl: string;
  readonly specUrl: string;
}

export const DEFAULT_CONFIG: SiteConfig = {
  docsNpub: '',
  relays: [],
  network: 'devnet',
  gatewayDomain: '',
  aurPackage: 'toon-console',
  repoUrl: 'https://github.com/toon-protocol/console',
  specUrl: 'https://github.com/toon-protocol/TOON_Network',
};

/** Never rejects: a missing or broken config file leaves the defaults. */
export async function loadConfig(
  fetchImpl: typeof fetch = fetch,
  url = '/site-config.json'
): Promise<SiteConfig> {
  try {
    const response = await fetchImpl(url, { cache: 'no-cache' });
    if (!response.ok) return DEFAULT_CONFIG;
    const raw: unknown = await response.json();
    if (typeof raw !== 'object' || raw === null) return DEFAULT_CONFIG;
    const fields = raw as Record<string, unknown>;
    return {
      docsNpub: string(fields['docsNpub']) ?? DEFAULT_CONFIG.docsNpub,
      relays: Array.isArray(fields['relays'])
        ? fields['relays'].filter((entry): entry is string => typeof entry === 'string')
        : DEFAULT_CONFIG.relays,
      network: string(fields['network']) ?? DEFAULT_CONFIG.network,
      gatewayDomain: string(fields['gatewayDomain']) ?? DEFAULT_CONFIG.gatewayDomain,
      aurPackage: string(fields['aurPackage']) ?? DEFAULT_CONFIG.aurPackage,
      repoUrl: string(fields['repoUrl']) ?? DEFAULT_CONFIG.repoUrl,
      specUrl: string(fields['specUrl']) ?? DEFAULT_CONFIG.specUrl,
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
