import type { SiteConfig } from '@/lib/config';
import type { Doc } from '@/lib/docs';

import { CopyButton } from './copy-button';
import { HeroBanner } from './hero-banner';
import { LeaseMeter } from './lease-meter';

/**
 * The landing page (TOON_Network#102).
 *
 * It has one job: get a visitor from "what is this" to an installed console.
 * Everything on it is either a fact about what exists today or a step towards
 * `yay -S toon-console`.
 *
 * It is honest first and impressive second, which is the reverse of how a
 * landing page usually goes. The devnet is said in the nav bar and again in
 * the first paragraph rather than in a footnote, the prices are the real ones
 * the devnet provider publishes, and the section about gas says the thing
 * nobody wants to put on a landing page: no faucet gives you any. A person who
 * installs this and then discovers the gas problem for themselves has been
 * misled; a person who reads it here has been told.
 *
 * The mission band is the one surface on the page that inverts, because it is
 * the one claim the whole project is answerable to. Everything under it is
 * evidence for it: what exists, how it works, what it costs, how to run it.
 */

export function Landing({
  config,
  docs,
  onOpenDoc,
}: {
  config: SiteConfig;
  docs: readonly Doc[];
  onOpenDoc: (d: string) => void;
}) {
  const install = `yay -S ${config.aurPackage}\ntoon-console-install\ntoon-console`;
  const fromSource = `git clone ${config.repoUrl}\ncd console && npm install && npm run build && npm start`;

  return (
    <main className="landing" id="start">
      <section className="hero">
        <div className="wrap">
          <HeroBanner />
          <h1>
            Pay for an hour of somebody&rsquo;s machine.
            <br /> That is the whole relationship.
          </h1>
          <p className="lede">
            There is nothing to open an account with. A <strong>Provider</strong> publishes
            what it sells to a relay; you take a <strong>Lease</strong> on a{' '}
            <strong>Workload</strong> and pay for it packet by packet over a payment channel.
            The provider never learns who you are, only that whoever asks again is whoever paid
            — and while the lease is paid, nobody has the standing to stop it.
          </p>
          <p className="disclosure">
            It runs today on a devnet: one public provider, test chains, mock money. There is
            no public mainnet provider yet.
          </p>
          <div className="cta">
            <a className="button primary" href="#install">
              <svg
                width="14"
                height="14"
                viewBox="0 0 14 14"
                aria-hidden="true"
                focusable="false"
              >
                <rect x="6" y="0" width="2" height="8" fill="currentColor" />
                <rect x="2" y="5" width="2" height="2" fill="currentColor" />
                <rect x="4" y="7" width="2" height="2" fill="currentColor" />
                <rect x="8" y="7" width="2" height="2" fill="currentColor" />
                <rect x="10" y="5" width="2" height="2" fill="currentColor" />
                <rect x="0" y="12" width="14" height="2" fill="currentColor" />
              </svg>
              Install the console
            </a>
            <button
              className="button ghost"
              type="button"
              onClick={() => onOpenDoc('concepts')}
            >
              Read the docs
            </button>
          </div>
          <LeaseMeter />
        </div>
      </section>

      <section className="mission" aria-label="Why this exists">
        <div className="wrap">
          <h2>Compute should be something you buy, not something you sign up for.</h2>
          <p>
            Every machine you can rent today comes with a company attached: an account to open,
            an identity to prove, a card on file, terms you accepted, and a switch somebody
            else can flip. TOON Network takes the company out of the middle. A provider
            publishes what it sells and what it charges. You pay for an hour of it with a
            sealed packet, and you hold the only secret that can ask for that machine again.{' '}
            <strong>
              Nobody approves you, nobody invoices you, and while the lease is paid, nobody can
              turn it off.
            </strong>
          </p>
          <p className="signature">
            Nothing here is a promise about a later version. What the network does today is
            written down in the specification; what it does not do yet is written down on this
            page.
          </p>
        </div>
      </section>

      <section className="band plainly" aria-label="What exists today">
        <div className="wrap">
          <h2>What exists today, plainly</h2>
          <ul>
            <li>
              <strong>This is a devnet, not a mainnet.</strong> There is one public provider,
              on test chains, settling in a mock USDC. The console ships a mainnet profile with
              nothing behind it, because pointing it at a guess would be worse than admitting
              there is nothing there.
            </li>
            <li>
              <strong>It really works.</strong> The console signs in with a Nostr signer, seals
              itself a Chain Seed, opens a channel on Base Sepolia or Solana devnet, leases a
              workload from the devnet provider and reaches it on a gateway hostname. That is
              not a roadmap; it happened.
            </li>
            <li>
              <strong>Native gas is the one thing no faucet gives you.</strong> The devnet
              faucet mints mock USDC. Opening a payment channel is an on-chain transaction and
              costs Base Sepolia ETH or Solana devnet SOL, which you have to get from a public
              testnet faucet yourself.
            </li>
          </ul>
        </div>
      </section>

      <section className="band how">
        <div className="wrap">
          <h2>How it works</h2>
          <ol className="steps">
            <li>
              <h3>A provider publishes</h3>
              <p>
                A <strong>Provider Profile</strong> says who it is and how it is paid. A{' '}
                <strong>Listing</strong> says what it sells. A short-lived{' '}
                <strong>Liveness</strong> event says it is still up. All three live on relays,
                so the <strong>Provider Directory</strong> is not a registry anybody runs — it
                is just what is published.
              </p>
            </li>
            <li>
              <h3>You take a lease</h3>
              <p>
                You mint a <strong>Root Secret</strong>, keep it, and derive a{' '}
                <strong>Continuation Token</strong> from it for that provider. The provider
                learns that the same party is asking again, and nothing else. A{' '}
                <strong>Tenant</strong> has no published identity and signs nothing.
              </p>
            </li>
            <li>
              <h3>You pay per packet</h3>
              <p>
                Opening a payment channel is the only thing that touches a chain. After that, a
                spawn or an extension is a sealed packet with a balance proof on it. No block,
                no wait, no invoice.
              </p>
            </li>
            <li>
              <h3>It stays reachable</h3>
              <p>
                Hand the workload to a <strong>Workload Gateway</strong> and it gets a stable
                hostname on TLS that resolves to whichever provider is running it — including
                after a <strong>Warm Standby</strong> takes over.
              </p>
            </li>
          </ol>
        </div>
      </section>

      <section className="band prices">
        <div className="wrap">
          <h2>What the devnet provider sells</h2>
          <table>
            <thead>
              <tr>
                <th>Listing</th>
                <th>Price</th>
                <th>Lease Interval</th>
                <th>What it grants</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>basic</code>
                </td>
                <td>1000 µUSDC</td>
                <td>3600 s</td>
                <td>An ordinary workload</td>
              </tr>
              <tr>
                <td>
                  <code>ci</code>
                </td>
                <td>5000 µUSDC</td>
                <td>3600 s</td>
                <td>The Docker Capability: a Docker daemon of the workload&rsquo;s own</td>
              </tr>
            </tbody>
          </table>
          <p className="note">
            µUSDC is a millionth of a USDC. On devnet it is a mock token and the faucet gives
            it away. A workload handed to the gateway answers at a name under{' '}
            <code className="live">
              {config.gatewayDomain || 'gw.devnet.toonprotocol.dev'}
            </code>
            .
          </p>
        </div>
      </section>

      <section className="band install-band" id="install">
        <div className="wrap">
          <h2>Install the console</h2>
          <p>
            The <strong>Console</strong> is a local app, not a website: a{' '}
            <code>systemd --user</code> daemon plus a web UI, opened as an Omarchy web app. It
            holds your keys on your machine, and nothing about your account reaches a server
            anyone else operates.
          </p>
          <div className="terminal">
            <pre>
              <code>{install}</code>
            </pre>
            <CopyButton text={install} what="the install commands" />
          </div>
          <p>
            On another Linux desktop the same package installs a plain <code>.desktop</code>{' '}
            file. From a checkout:
          </p>
          <div className="terminal">
            <pre>
              <code>{fromSource}</code>
            </pre>
            <CopyButton text={fromSource} what="the commands to build from source" />
          </div>
          <p className="note">
            It prints an <code>open:</code> URL carrying that launch&rsquo;s token. Open it,
            and follow{' '}
            <button className="link" type="button" onClick={() => onOpenDoc('first-workload')}>
              Your first workload
            </button>
            .
          </p>
        </div>
      </section>

      <section className="band reading">
        <div className="wrap">
          <h2>The documentation</h2>
          <ul className="doc-list" aria-label="Documentation">
            {docs.map((doc) => (
              <li key={doc.d}>
                <button type="button" className="doc-link" onClick={() => onOpenDoc(doc.d)}>
                  <span className="doc-title">{doc.title}</span>
                  <span className="doc-summary">{doc.summary}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}
