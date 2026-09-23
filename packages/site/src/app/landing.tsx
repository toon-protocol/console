import type { SiteConfig } from '@/lib/config';
import type { Doc } from '@/lib/docs';

/**
 * The landing page (TOON_Network#102).
 *
 * It has one job: get a visitor from "what is this" to an installed console.
 * Everything on it is either a fact about what exists today or a step towards
 * `yay -S toon-console`.
 *
 * It is honest first and impressive second, which is the reverse of how a
 * landing page usually goes. The devnet banner is the first thing under the
 * headline rather than a footnote, the prices are the real ones the devnet
 * provider publishes, and the section about gas says the thing nobody wants to
 * put on a landing page: no faucet gives you any. A person who installs this
 * and then discovers the gas problem for themselves has been misled; a person
 * who reads it here has been told.
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
  return (
    <main className="landing">
      <section className="hero">
        <p className="eyebrow">Devnet, running now</p>
        <h1>
          Rent a machine from somebody you have never met, and never tell them who you are.
        </h1>
        <p className="lede">
          TOON Network is a compute marketplace with nobody in the middle. A{' '}
          <strong>Provider</strong> publishes what it sells to a relay. You take a{' '}
          <strong>Lease</strong> on a <strong>Workload</strong> and pay for it packet by packet
          over a payment channel. There is no account to open with anyone, no invoice, and no
          company that could turn you off.
        </p>
        <div className="cta">
          <a className="button primary" href="#install">
            Install the console
          </a>
          <button className="button ghost" type="button" onClick={() => onOpenDoc('concepts')}>
            Read the docs
          </button>
        </div>
      </section>

      <section className="honest" aria-label="What exists today">
        <h2>What exists today, plainly</h2>
        <ul>
          <li>
            <strong>This is a devnet, not a mainnet.</strong> There is one public provider, on
            test chains, settling in a mock USDC. The console ships a mainnet profile with
            nothing behind it, because pointing it at a guess would be worse than admitting
            there is nothing there.
          </li>
          <li>
            <strong>It really works.</strong> The console signs in with a Nostr signer, seals
            itself a Chain Seed, opens a channel on Base Sepolia or Solana devnet, leases a
            workload from the devnet provider and reaches it on a gateway hostname. That is not
            a roadmap; it happened.
          </li>
          <li>
            <strong>Native gas is the one thing no faucet gives you.</strong> The devnet faucet
            mints mock USDC. Opening a payment channel is an on-chain transaction and costs
            Base Sepolia ETH or Solana devnet SOL, which you have to get from a public testnet
            faucet yourself.
          </li>
        </ul>
      </section>

      <section className="how">
        <h2>How it works</h2>
        <ol className="steps">
          <li>
            <h3>A provider publishes</h3>
            <p>
              A <strong>Provider Profile</strong> says who it is and how it is paid. A{' '}
              <strong>Listing</strong> says what it sells. A short-lived{' '}
              <strong>Liveness</strong> event says it is still up. All three live on relays, so
              the <strong>Provider Directory</strong> is not a registry anybody runs — it is
              just what is published.
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
              spawn or an extension is a sealed packet with a balance proof on it. No block, no
              wait, no invoice.
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
      </section>

      <section className="prices">
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
          µUSDC is a millionth of a USDC. On devnet it is a mock token and the faucet gives it
          away. A workload handed to the gateway answers at a name under{' '}
          <code>{config.gatewayDomain || 'gw.devnet.toonprotocol.dev'}</code>.
        </p>
      </section>

      <section className="install" id="install">
        <h2>Install the console</h2>
        <p>
          The <strong>Console</strong> is a local app, not a website: a{' '}
          <code>systemd --user</code> daemon plus a web UI, opened as an Omarchy web app. It
          holds your keys on your machine, and nothing about your account reaches a server
          anyone else operates.
        </p>
        <pre>
          <code>{`yay -S ${config.aurPackage}\ntoon-console-install\ntoon-console`}</code>
        </pre>
        <p>
          On another Linux desktop the same package installs a plain <code>.desktop</code>{' '}
          file. From a checkout:
        </p>
        <pre>
          <code>{`git clone ${config.repoUrl}\ncd console && npm install && npm run build && npm start`}</code>
        </pre>
        <p className="note">
          It prints an <code>open:</code> URL carrying that launch&rsquo;s token. Open it, and
          follow{' '}
          <button className="link" type="button" onClick={() => onOpenDoc('first-workload')}>
            Your first workload
          </button>
          .
        </p>
      </section>

      <section className="reading">
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
      </section>
    </main>
  );
}
