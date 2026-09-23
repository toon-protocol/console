import { describe, expect, it, vi } from 'vitest';

import {
  AnonTransport,
  HiddenTransportError,
  carriageRefusal,
  isHiddenServiceUrl,
  isNearUrl,
  isPrivateAddress,
  proxyRpcFor,
} from './hidden-transport.js';

/**
 * Reaching a Hidden Provider (TOON_Network#98, spec §10, ADR 0008).
 *
 * Nothing here dials anything: the client's `hidden-service` entry is injected,
 * so what is under test is the console's own decisions — which are all the same
 * decision seen from four sides. **No circuit means no packet.** Not a slower
 * packet, not a packet at the other address the Profile happened to carry.
 */
describe('the Anyone Protocol carriage', () => {
  const fakeModule = (overrides: Partial<Record<string, unknown>> = {}) => {
    const closed = vi.fn(() => Promise.resolve());
    const module = {
      probeSocks5Proxy: vi.fn(() => Promise.resolve()),
      validateSocks5hUrl: vi.fn((url: string) => {
        if (!url.startsWith('socks5h://')) throw new Error('must be socks5h://');
        return { host: '127.0.0.1', port: 19050 };
      }),
      createHiddenServiceTransport: vi.fn(() => ({
        fetch: (() => Promise.reject(new Error('not dialled'))) as unknown as typeof fetch,
        createWebSocket: () => undefined,
        dispatcher: {},
        close: closed,
      })),
      ...overrides,
    };
    return { module, closed };
  };

  it('opens one carriage and shares it', async () => {
    const { module } = fakeModule();
    const transport = new AnonTransport({
      socksProxy: () => 'socks5h://127.0.0.1:19050',
      load: () => Promise.resolve(module as never),
    });

    const first = await transport.open();
    const second = await transport.open();

    expect(first).toBe(second);
    expect(module.createHiddenServiceTransport).toHaveBeenCalledTimes(1);
    expect(first.socksProxy).toBe('socks5h://127.0.0.1:19050');
  });

  it('refuses with something to start when no proxy is set', async () => {
    const transport = new AnonTransport({ socksProxy: () => undefined });

    await expect(transport.open()).rejects.toMatchObject({ code: 'no_anon_proxy' });
    await expect(transport.open()).rejects.toThrow(/TOON_CONSOLE_SOCKS_PROXY/u);
    // It says nothing was dialled, because nothing was.
    await expect(transport.open()).rejects.toThrow(/Nothing was dialled/u);
    await expect(transport.describe()).resolves.toMatchObject({ state: 'unconfigured' });
  });

  it('probes before it builds, so a dead daemon costs no claim', async () => {
    const { module } = fakeModule({
      probeSocks5Proxy: vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    });
    const transport = new AnonTransport({
      socksProxy: () => 'socks5h://127.0.0.1:19050',
      load: () => Promise.resolve(module as never),
    });

    await expect(transport.open()).rejects.toMatchObject({ code: 'anon_unreachable' });
    expect(module.createHiddenServiceTransport).not.toHaveBeenCalled();
  });

  it('tries again after a failure rather than refusing for the session', async () => {
    let up = false;
    const { module } = fakeModule({
      probeSocks5Proxy: vi.fn(() =>
        up ? Promise.resolve() : Promise.reject(new Error('not yet'))
      ),
    });
    const transport = new AnonTransport({
      socksProxy: () => 'socks5h://127.0.0.1:19050',
      load: () => Promise.resolve(module as never),
    });

    await expect(transport.open()).rejects.toThrow(HiddenTransportError);
    up = true;
    await expect(transport.open()).resolves.toMatchObject({
      socksProxy: 'socks5h://127.0.0.1:19050',
    });
  });

  it('refuses a `socks5://` proxy: the `h` is what keeps the name off DNS', async () => {
    const { module } = fakeModule();
    const transport = new AnonTransport({
      socksProxy: () => 'socks5://127.0.0.1:19050',
      load: () => Promise.resolve(module as never),
    });

    await expect(transport.open()).rejects.toMatchObject({ code: 'bad_anon_proxy' });
    expect(module.probeSocks5Proxy).not.toHaveBeenCalled();
  });

  it('closes the pool it built', async () => {
    const { module, closed } = fakeModule();
    const transport = new AnonTransport({
      socksProxy: () => 'socks5h://127.0.0.1:19050',
      load: () => Promise.resolve(module as never),
    });

    await transport.open();
    await transport.close();

    expect(closed).toHaveBeenCalledTimes(1);
  });
});

/**
 * The refusal ported from the provider publisher's `transportRefusal`.
 *
 * There a BTP websocket bypassed a `fetch`-installed proxy. Here the client
 * wires the websocket itself, so the hole is the other way round: it resolves
 * `config.fetch ?? transport.fetch`, and anything injected wins silently.
 */
describe('what may ride beside the proxy', () => {
  it('lets a clearnet packet carry whatever it likes', () => {
    expect(carriageRefusal({ fetch: () => undefined })).toBeNull();
    expect(carriageRefusal({ createWebSocket: () => undefined })).toBeNull();
  });

  it('refuses an injected `fetch` beside a proxy', () => {
    expect(
      carriageRefusal({ socksProxy: 'socks5h://127.0.0.1:19050', fetch: globalThis.fetch })
    ).toMatch(/injected one wins/u);
  });

  it('refuses an injected websocket beside a proxy, because BTP is one', () => {
    expect(
      carriageRefusal({
        socksProxy: 'socks5h://127.0.0.1:19050',
        createWebSocket: () => undefined,
      })
    ).toMatch(/BTP/u);
  });

  it('lets the proxy alone through: the client builds all three from it', () => {
    expect(carriageRefusal({ socksProxy: 'socks5h://127.0.0.1:19050' })).toBeNull();
  });
});

describe('a `.anyone` address', () => {
  it('is the only TLD `anon` routes', () => {
    expect(isHiddenServiceUrl(`http://${'a'.repeat(56)}.anyone/ilp`)).toBe(true);
    expect(isHiddenServiceUrl(`ws://${'a'.repeat(56)}.anyone:7100`)).toBe(true);
    // `.anon` and `.onion` are clearnet names to `anon`, and fail late.
    expect(isHiddenServiceUrl('http://abc.anon/ilp')).toBe(false);
    expect(isHiddenServiceUrl('http://abc.onion/ilp')).toBe(false);
    expect(isHiddenServiceUrl('http://localhost:3200/ilp')).toBe(false);
    expect(isHiddenServiceUrl('not a url')).toBe(false);
  });
});

/**
 * Whether the chain rides the circuit — ADR 0008's third leg, from this side.
 *
 * A public RPC endpoint must, or the payer's settlement address is broadcast
 * from this machine's own IP either side of every paid packet. A private one
 * must not: `anon` builds no circuit to it, so proxying would fail rather than
 * hide anything.
 */
describe('whether the chain RPC rides the circuit', () => {
  const lookup = ((host: string) =>
    host === 'chain.internal'
      ? Promise.resolve([{ address: '10.0.0.4', family: 4 }])
      : host === 'mixed.example'
        ? Promise.resolve([
            { address: '10.0.0.4', family: 4 },
            { address: '93.184.216.34', family: 4 },
          ])
        : host === 'nowhere.example'
          ? Promise.reject(new Error('ENOTFOUND'))
          : Promise.resolve([{ address: '93.184.216.34', family: 4 }])) as never;

  it('knows a private address from a public one', () => {
    for (const near of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.1.1',
      '::1',
      'fd00::1',
    ])
      expect(isPrivateAddress(near)).toBe(true);
    for (const far of ['8.8.8.8', '93.184.216.34', '2606:4700::1'])
      expect(isPrivateAddress(far)).toBe(false);
    expect(isPrivateAddress('::ffff:10.0.0.4')).toBe(true);
  });

  it('leaves the sandbox’s loopback chain alone', async () => {
    await expect(proxyRpcFor('http://localhost:8545', lookup)).resolves.toBe(false);
    await expect(proxyRpcFor('http://127.0.0.1:8899', lookup)).resolves.toBe(false);
  });

  it('puts a public chain endpoint on the circuit', async () => {
    await expect(proxyRpcFor('https://sepolia.base.org', lookup)).resolves.toBe(true);
  });

  it('proxies a name that answers with even one public address', async () => {
    await expect(isNearUrl('http://mixed.example:8545', lookup)).resolves.toBe(false);
    await expect(isNearUrl('http://chain.internal:8545', lookup)).resolves.toBe(true);
  });

  it('proxies a name that does not resolve: the safe way to be wrong', async () => {
    await expect(isNearUrl('http://nowhere.example:8545', lookup)).resolves.toBe(false);
    await expect(isNearUrl('not a url', lookup)).resolves.toBe(false);
  });
});
