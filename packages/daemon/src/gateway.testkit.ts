import type { ChainSeedStore } from './chain-seed.js';
import type { ConnectorHealth } from './connector-health.js';
import { GatewayStore, type GatewayProbe, type ProbeAnswer } from './gateway.js';
import { connectorHealth } from './lease.testkit.js';
import type { FakeProviderPort } from './lease.testkit.js';
import { fakeProviderPort } from './lease.testkit.js';
import type { PacketOutcome } from './lease.js';
import type { LeaseVault } from './lease-vault.js';
import type { ConsolePaths } from './paths.js';
import { SANDBOX, type NetworkProfile } from './profiles.js';
import { InMemoryWorkloadNoteStore, type WorkloadNoteStore } from './workload-cache.js';
import { providerRoutes } from './workload.testkit.js';

/**
 * A Workload Gateway over fakes (TOON_Network#97).
 *
 * Faked for the reason the dashboard's is: every case this ticket turns on is
 * a gateway behaving in a way no live one can be asked to behave on demand —
 * refusing `not_admitted` because a member would not vouch for a grant,
 * answering a hostname that is not the one derived, going silent after taking
 * the message — and each decides something different about what a person is
 * told and about what the console then believes it holds.
 *
 * What is NOT faked is the derivation. Every test below reads the grants out
 * of the body the fake was handed and checks them against §6.5.1's own
 * arithmetic over the vault's real Root Secret, so "one grant per member,
 * derived from that member's own token" is checked against the spec rather
 * than against this file.
 */

/** The gateway's connector, as its own `GET /ilp` describes it. */
export const GATEWAY_CONNECTOR = 'https://gateway.example/ilp';
export const GATEWAY_ADDRESS = 'g.toon.workload-gateway';
export const GATEWAY_ROUTE = `${GATEWAY_ADDRESS}.handover`;
export const GATEWAY_DOMAIN_SUFFIX = 'gw.example';
/** The edge's own uncompressed secp256k1 key, as `GET /ilp` prints it. */
export const GATEWAY_SEAL_KEY = `0x04${'ab'.repeat(64)}`;

/** A profile whose gateway is the fake one above. */
export function gatewayProfile(overrides: Partial<NetworkProfile> = {}): NetworkProfile {
  return {
    ...SANDBOX,
    gatewayDomain: GATEWAY_DOMAIN_SUFFIX,
    gatewayConnectorUrl: GATEWAY_CONNECTOR,
    ...overrides,
  };
}

/**
 * The two connectors in play, told apart — devnet's shape.
 *
 * The profile's own connector publishes nothing towards the gateway (on
 * devnet it fronts the relay and peers with nobody), and the gateway's own
 * terminates its one route at nothing, as §12.1's deployments all do.
 */
export function gatewayHealth(
  input: {
    price?: string;
    routes?: readonly { prefix: string; price: string }[];
    /**
     * What the gateway's connector says about ITSELF — defaults to
     * `GATEWAY_CONNECTOR`. Give a different value to simulate the sandbox's
     * shape (TOON_Network#129): the connector reached under one spelling of
     * its host that publishes another.
     */
    selfEndpoint?: string;
  } = {}
) {
  return (asked: NetworkProfile): Promise<ConnectorHealth> => {
    if (asked.connectorUrl !== GATEWAY_CONNECTOR) {
      return Promise.resolve(
        connectorHealth({ endpoint: asked.connectorUrl, routes: providerRoutes({}) })
      );
    }
    return Promise.resolve(
      connectorHealth({
        endpoint: asked.connectorUrl,
        ...(input.selfEndpoint === undefined ? {} : { selfEndpoint: input.selfEndpoint }),
        ilpAddresses: [GATEWAY_ADDRESS],
        edgeSealKey: GATEWAY_SEAL_KEY,
        routes: input.routes ?? [{ prefix: GATEWAY_ROUTE, price: input.price ?? '0' }],
      })
    );
  };
}

/** §12.1's answer to a handover that was admitted. */
export function handoverOk(hostname: string, expiresAt?: number): PacketOutcome {
  return answered({
    workload_id: 'echoed',
    hostname,
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  });
}

/** §12.7's answer to a withdrawal that took effect. */
export function withdrawalOk(hostname: string): PacketOutcome {
  return answered({ workload_id: 'echoed', hostname, withdrawn: true });
}

/** §5's two-key refusal, as a gateway answers one. */
export function gatewayRefusal(error: string, message = 'no'): PacketOutcome {
  const body = { error, message };
  // 403, because that is what the reference gateway answers — and the status
  // is deliberately NOT what anything reads. §5 fixes the body as the
  // contract; the status is a courtesy to `curl`.
  return { kind: 'answered', status: 403, body, text: JSON.stringify(body) };
}

function answered(body: Record<string, unknown>): PacketOutcome {
  return { kind: 'answered', status: 200, body, text: JSON.stringify(body) };
}

/** A hostname that answers whatever a test tells it to. */
export interface FakeProbe extends GatewayProbe {
  readonly knocked: string[];
  answer: ProbeAnswer | Error | ((url: string) => ProbeAnswer);
}

export function fakeProbe(answer?: FakeProbe['answer']): FakeProbe {
  const probe: FakeProbe = {
    knocked: [],
    answer: answer ?? NO_GRANT,
    knock(url: string): Promise<ProbeAnswer> {
      probe.knocked.push(url);
      const given = typeof probe.answer === 'function' ? probe.answer(url) : probe.answer;
      if (given instanceof Error) return Promise.reject(given);
      return Promise.resolve(given);
    },
  };
  return probe;
}

/** §12.3's healthy empty state: the answer at a name nothing was handed to. */
export const NO_GRANT: ProbeAnswer = {
  status: 503,
  reason: 'no_grant',
  excerpt: '{"error":"no_grant",…}',
};

/** A workload answering for itself. Note the `200` is the WORKLOAD's, not a gateway's. */
export const SERVING: ProbeAnswer = { status: 200, excerpt: 'Hostname: whoami-1' };

export interface GatewayFixture {
  readonly gateway: GatewayStore;
  readonly port: FakeProviderPort;
  readonly probe: FakeProbe;
  readonly notes: WorkloadNoteStore;
}

export function gatewayFixture(input: {
  vault: LeaseVault;
  chainSeed: ChainSeedStore;
  paths: ConsolePaths;
  profile?: NetworkProfile;
  port?: FakeProviderPort;
  probe?: FakeProbe;
  notes?: WorkloadNoteStore;
  health?: (profile: NetworkProfile) => Promise<ConnectorHealth>;
  now?: () => Date;
}): GatewayFixture {
  const profile = input.profile ?? gatewayProfile();
  const port = input.port ?? fakeProviderPort(handoverOk('unset'));
  const probe = input.probe ?? fakeProbe();
  const notes = input.notes ?? new InMemoryWorkloadNoteStore(input.now);
  const gateway = new GatewayStore({
    profile: () => profile,
    vault: input.vault,
    chainSeed: input.chainSeed,
    readHealth: input.health ?? gatewayHealth(),
    gateway: port,
    probe,
    paths: input.paths,
    notes,
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { gateway, port, probe, notes };
}
