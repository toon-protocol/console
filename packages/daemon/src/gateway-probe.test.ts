import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LiveGatewayProbe } from './gateway-probe.js';

/**
 * Knocking on a hostname (TOON_Network#97, spec §12.3).
 *
 * The whole of what this has to get right is one distinction: a **gateway**
 * refusing to serve a name, against a **workload** answering for itself. Both
 * can be a `503`, both can carry `{"error": …}`, and confusing them would have
 * the console telling somebody their hostname was empty while their own app
 * was answering on it — or the reverse.
 */
describe('the hostname probe', () => {
  const answers = vi.fn<(url: string, init: RequestInit) => Response>();

  beforeEach(() => {
    vi.stubGlobal('fetch', (url: string, init: RequestInit) =>
      Promise.resolve(answers(url, init))
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    answers.mockReset();
  });

  const probe = new LiveGatewayProbe();

  it('reads §12.3’s reason from the gateway’s own header', async () => {
    answers.mockReturnValue(
      new Response('{"error":"no_grant","message":"nothing here"}', {
        status: 503,
        headers: { 'toon-gateway-reason': 'no_grant' },
      })
    );

    expect(await probe.knock('https://x.gw.example/')).toMatchObject({
      status: 503,
      reason: 'no_grant',
    });
  });

  it('reads it out of §5’s two-key body when the header is missing', async () => {
    answers.mockReturnValue(
      new Response('{"error":"grant_expired","message":"ran out"}', { status: 503 })
    );

    expect((await probe.knock('https://x.gw.example/')).reason).toBe('grant_expired');
  });

  it('does NOT read a workload’s own 503 as a gateway refusal', async () => {
    // A workload may answer anything, including `503` and including a JSON
    // body with an `error` in it. It is still the workload answering, which
    // is the whole point of having handed it over.
    answers.mockReturnValue(
      new Response('{"error":"database down","detail":"mine, not the gateway’s"}', {
        status: 503,
      })
    );
    const answer = await probe.knock('https://x.gw.example/');

    expect(answer.reason).toBeUndefined();
    expect(answer.status).toBe(503);
  });

  it('treats a workload’s own answer as an answer, whatever its status', async () => {
    answers.mockReturnValue(new Response('Hostname: whoami-1\n', { status: 200 }));
    const answer = await probe.knock('https://x.gw.example/');

    expect(answer.reason).toBeUndefined();
    expect(answer.excerpt).toBe('Hostname: whoami-1');
  });

  it('never follows a redirect', async () => {
    answers.mockReturnValue(new Response('', { status: 302 }));
    await probe.knock('https://x.gw.example/');

    expect(answers.mock.calls[0]?.[1].redirect).toBe('manual');
  });

  it('keeps only a short, flattened excerpt of somebody else’s workload', async () => {
    answers.mockReturnValue(new Response(`${'a'.repeat(5000)}\n\n  b`, { status: 200 }));
    const answer = await probe.knock('https://x.gw.example/');

    expect(answer.excerpt!.length).toBeLessThan(400);
    expect(answer.excerpt).toMatch(/…$/u);
  });
});
