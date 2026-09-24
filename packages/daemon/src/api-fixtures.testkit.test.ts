import { describe, expect, it } from 'vitest';

import { normalise } from './api-fixtures.testkit.js';

/**
 * `normalise` is what makes a committed fixture the same byte for byte every
 * `npm test` run (see its own doc comment) — but an earlier agent found
 * `funding.json` changing anyway, on a run that touched nothing. The cause:
 * a Solana address is 32 random bytes, and base58-encoding 32 random bytes
 * does not always produce the same LENGTH of string — a run whose bytes
 * happen to start with a zero byte encodes one character shorter (43 vs 44
 * being the two lengths seen in practice). `placeholderFor`'s `base58` case
 * used to keep the ORIGINAL string's length, so the placeholder it wrote
 * inherited that same run-to-run wobble even though every other volatile
 * field normalises to a fixed value. Every other identifier shape here (an
 * `0x`-address, a UUID, a hostname, hex) is fixed-length by construction, so
 * this is the one family that needed a length of its own rather than the
 * original's.
 */
describe('normalise', () => {
  it('gives two base58 identifiers of different real lengths the same placeholder length', () => {
    // Two different runs' own encodings of two DIFFERENT 32-byte keys — one
    // landed on 43 characters, the other on 44, exactly like two real
    // Solana addresses can. Each is normalised on its own here, the same
    // way `writeApiFixture` normalises one whole run's response at a time.
    const shorter = 'GJRs4FwHtemZ5ZE9x3yYYyLzGVUC4mFVjfRJzT2gBpV';
    const longer = `${shorter}V`;
    expect(shorter).toHaveLength(43);
    expect(longer).toHaveLength(44);

    const fromShorter = normalise({ counterparty: shorter }) as { counterparty: string };
    const fromLonger = normalise({ counterparty: longer }) as { counterparty: string };

    expect(fromShorter.counterparty.length).toBe(fromLonger.counterparty.length);
  });

  it('still gives two DIFFERENT base58 identifiers in the SAME response different placeholders', () => {
    const first = 'GJRs4FwHtemZ5ZE9x3yYYyLzGVUC4mFVjfRJzT2gBpV';
    const second = 'H8sMJSCQxfKiFTCfDR3DUMLPwcRbM2BjfemedNCV6R5t';
    const out = normalise({ counterparty: first, token: { address: second } }) as {
      counterparty: string;
      token: { address: string };
    };
    expect(out.counterparty).not.toBe(out.token.address);
  });

  it('still gives the SAME base58 identifier repeated in one response the SAME placeholder', () => {
    const address = 'GJRs4FwHtemZ5ZE9x3yYYyLzGVUC4mFVjfRJzT2gBpV';
    const out = normalise({ counterparty: address, token: { address } }) as {
      counterparty: string;
      token: { address: string };
    };
    expect(out.counterparty).toBe(out.token.address);
  });
});
