import { describe, expect, it } from 'vitest';

import { readTemplateContent } from './templates.js';
import { fakePublisher, sign } from './templates.testkit.js';
import { buildSmokeTemplateContent, smokeTemplateTags } from './smoke-console-run.js';

/**
 * The smoke's own Template content and tags (TOON_Network#138).
 *
 * The smoke publishes against `traefik/whoami`, a plain HTTP echo server with
 * no sshd. Before this ticket the Template it wrote said nothing about SSH —
 * which every OTHER Template also says, and reads as "cannot say either way,
 * so ask" (`templates.ts`) — so the New workload form asked for an SSH key
 * and the Workloads tab showed an `ssh` command that `ssh -p 40000` refused.
 * These two functions are the fix's whole surface on the publishing side, and
 * both are pure: no network, no payment, so they are worth pinning down with
 * nothing else running.
 */

const publisher = fakePublisher('smoke-template-content');

describe('buildSmokeTemplateContent', () => {
  const content = buildSmokeTemplateContent({
    digest: `sha256:${'a'.repeat(64)}`,
    entryAddress: `30434:${publisher.pubkey}:whoami:latest`,
    relay: 'wss://provider.relay.test',
  });

  it('says plainly that it offers no SSH', () => {
    expect(content.ssh_offered).toBe(false);
  });

  it('names the image by content address, with the given registry entry and relay hint', () => {
    expect(content.image).toEqual({
      digest: `sha256:${'a'.repeat(64)}`,
      registry_entry: {
        address: `30434:${publisher.pubkey}:whoami:latest`,
        relay: 'wss://provider.relay.test',
      },
    });
  });

  it('fixes no environment and settles no tenant setting, matching `traefik/whoami`', () => {
    expect(content.env_fixed).toEqual({});
    expect(content.env_tenant).toEqual([]);
  });

  it('is a Template `readTemplateContent` actually accepts, and reads `sshOffered: false` back', () => {
    const event = sign(publisher, {
      kind: 30436,
      created_at: 1_790_000_000,
      tags: smokeTemplateTags(),
      content: JSON.stringify(content),
    });
    const read = readTemplateContent(event);
    if ('reason' in read) throw new Error(`refused: ${read.reason}`);
    expect(read.sshOffered).toBe(false);
    expect(read.ports).toEqual([{ containerPort: 80, protocol: 'tcp' }]);
  });
});

describe('smokeTemplateTags', () => {
  const tags = smokeTemplateTags();

  it('keeps the `d` this run has always used, so a re-run REPLACES the old, SSH-claiming event', () => {
    expect(tags).toContainEqual(['d', 'toon-console-smoke']);
  });

  it('carries the `toon.network` label `readTemplates` filters on', () => {
    expect(tags).toContainEqual(['L', 'toon.network']);
  });

  it('titles itself as a test fixture with no SSH, in words a person reads on the card', () => {
    const title = tags.find(([name]) => name === 'title')?.[1];
    expect(title).toBe('Smoke test — HTTP echo (no SSH)');
    const summary = tags.find(([name]) => name === 'summary')?.[1];
    expect(summary).toMatch(/no sshd/u);
    expect(summary).toMatch(/throwaway test fixture/u);
  });
});
