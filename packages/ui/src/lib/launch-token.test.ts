import { beforeEach, describe, expect, it } from 'vitest';

import { adoptLaunchToken, forgetLaunchToken, launchToken } from './launch-token';

describe('adopting the launch token', () => {
  beforeEach(() => {
    forgetLaunchToken();
  });

  it('takes the token off the URL and keeps it for the tab', () => {
    const replaced: string[] = [];
    const history = {
      replaceState: (_: unknown, __: string, url: string) => replaced.push(url),
    } as unknown as History;

    const token = adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=secret-token') as unknown as Location,
      history
    );

    expect(token).toBe('secret-token');
    expect(launchToken()).toBe('secret-token');
    // The token must not survive in the address bar, where it would be
    // bookmarked, copied out of the window, or read by a screen recording.
    expect(replaced).toEqual(['/']);
    expect(replaced[0]).not.toContain('secret-token');
  });

  it('keeps other query parameters when it strips the token', () => {
    const replaced: string[] = [];
    const history = {
      replaceState: (_: unknown, __: string, url: string) => replaced.push(url),
    } as unknown as History;

    adoptLaunchToken(
      new URL('http://127.0.0.1:7797/?t=secret&view=health#x') as unknown as Location,
      history
    );

    expect(replaced[0]).toBe('/?view=health#x');
  });

  it('survives a reload, when the URL no longer carries a token', () => {
    const history = { replaceState: () => undefined } as unknown as History;
    adoptLaunchToken(new URL('http://127.0.0.1:7797/?t=kept') as unknown as Location, history);
    expect(
      adoptLaunchToken(new URL('http://127.0.0.1:7797/') as unknown as Location, history)
    ).toBe('kept');
  });

  it('has no token when the window was not opened by a launcher', () => {
    const history = { replaceState: () => undefined } as unknown as History;
    expect(
      adoptLaunchToken(new URL('http://127.0.0.1:7797/') as unknown as Location, history)
    ).toBeUndefined();
  });
});
