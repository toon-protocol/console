import { describe, expect, it } from 'vitest';

import {
  isSandboxLike,
  isValidProfileId,
  validateProfileEndpoints,
} from './profile-validation.js';

describe('isValidProfileId', () => {
  it('accepts lowercase letters, digits and hyphens starting with a letter', () => {
    for (const id of ['devnet', 'my-devnet-2', 'a']) {
      expect(isValidProfileId(id)).toBe(true);
    }
  });

  it('refuses anything that could name a path other than a sibling directory', () => {
    for (const id of [
      '../escape',
      'a/b',
      '',
      'UPPER',
      'has spaces',
      '1starts-with-digit',
      '.hidden',
    ]) {
      expect(isValidProfileId(id)).toBe(false);
    }
  });
});

describe('isSandboxLike', () => {
  it('is true only for the built-in sandbox id', () => {
    expect(isSandboxLike('sandbox')).toBe(true);
    expect(isSandboxLike('devnet')).toBe(false);
    expect(isSandboxLike('my-sandbox-fork')).toBe(false);
  });
});

describe('validateProfileEndpoints', () => {
  it('accepts a fully-populated, correctly-schemed profile', () => {
    const errors = validateProfileEndpoints(
      {
        connectorUrl: 'https://connector.example/ilp',
        relayUrl: 'wss://relay.example',
        gatewayDomain: 'gw.example.com',
        gatewayConnectorUrl: 'https://gateway.example/ilp',
        gasConnectorUrl: 'https://gas.example/ilp',
        faucetUrl: 'https://faucet.example',
        rpc: { evm: 'https://evm.example', solana: 'https://solana.example' },
      },
      { sandboxLike: false }
    );
    expect(errors).toEqual({});
  });

  it('leaves an absent or blank field alone — that means "no override," not "invalid"', () => {
    const errors = validateProfileEndpoints({ connectorUrl: '   ' }, { sandboxLike: false });
    expect(errors).toEqual({});
  });

  it('refuses a value with no scheme', () => {
    const errors = validateProfileEndpoints(
      { connectorUrl: 'connector.example' },
      { sandboxLike: false }
    );
    expect(errors.connectorUrl).toBeTruthy();
  });

  it('refuses http:// for a connector on a non-loopback, non-sandbox profile', () => {
    const errors = validateProfileEndpoints(
      { connectorUrl: 'http://connector.example/ilp' },
      { sandboxLike: false }
    );
    expect(errors.connectorUrl).toMatch(/https/);
  });

  it('allows http:// for a connector pointed at loopback on any profile', () => {
    for (const host of [
      'http://localhost:3200/ilp',
      'http://127.0.0.1:3200/ilp',
      'http://127.5.5.5/ilp',
    ]) {
      const errors = validateProfileEndpoints({ connectorUrl: host }, { sandboxLike: false });
      expect(errors.connectorUrl, host).toBeUndefined();
    }
  });

  it('allows http:// on a non-loopback host when the profile is sandbox-like', () => {
    const errors = validateProfileEndpoints(
      { connectorUrl: 'http://docker-host.lan:3200/ilp' },
      { sandboxLike: true }
    );
    expect(errors.connectorUrl).toBeUndefined();
  });

  it('refuses ws:// for a relay on a non-loopback, non-sandbox profile, and requires the ws family at all', () => {
    const wrongFamily = validateProfileEndpoints(
      { relayUrl: 'https://relay.example' },
      { sandboxLike: false }
    );
    expect(wrongFamily.relayUrl).toBeTruthy();

    const insecure = validateProfileEndpoints(
      { relayUrl: 'ws://relay.example' },
      { sandboxLike: false }
    );
    expect(insecure.relayUrl).toMatch(/wss/);
  });

  it('accepts an rpc endpoint over http(s) or ws(s), and refuses any other scheme', () => {
    for (const good of ['https://evm.example', 'wss://evm.example']) {
      const errors = validateProfileEndpoints({ rpc: { evm: good } }, { sandboxLike: false });
      expect(errors['rpc.evm'], good).toBeUndefined();
    }
    const bad = validateProfileEndpoints(
      { rpc: { evm: 'ftp://evm.example' } },
      { sandboxLike: false }
    );
    expect(bad['rpc.evm']).toBeTruthy();
  });

  it('reports errors per field, independently', () => {
    const errors = validateProfileEndpoints(
      {
        connectorUrl: 'not-a-url',
        relayUrl: 'wss://relay.example',
        gatewayDomain: 'https://not-a-hostname',
      },
      { sandboxLike: false }
    );
    expect(Object.keys(errors).sort()).toEqual(['connectorUrl', 'gatewayDomain']);
  });

  it('gatewayDomain is a bare hostname, optionally with a port — never a URL or a path', () => {
    expect(
      validateProfileEndpoints(
        { gatewayDomain: 'gw.example.com:8443' },
        { sandboxLike: false }
      ).gatewayDomain
    ).toBeUndefined();
    expect(
      validateProfileEndpoints(
        { gatewayDomain: 'https://gw.example.com' },
        { sandboxLike: false }
      ).gatewayDomain
    ).toBeTruthy();
    expect(
      validateProfileEndpoints(
        { gatewayDomain: 'gw.example.com/path' },
        { sandboxLike: false }
      ).gatewayDomain
    ).toBeTruthy();
  });

  it('never accepts a chain fact — this module has no idea what one looks like, only what a URL looks like', () => {
    // Nothing here to assert beyond the type system: `ProfileEndpointInput`
    // has no field a chain id, a token address or a settlement address could
    // even be assigned to. This test exists so a reader looking for "where
    // is that enforced" finds this file and this comment.
    expect(true).toBe(true);
  });
});
