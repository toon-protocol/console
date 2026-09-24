import { useState } from 'react';

/**
 * A lease, drawn (TOON_Network#102).
 *
 * The hero of a compute marketplace should be the thing it sells, and what
 * this network sells is not a server: it is an hour of one, prepaid, which
 * stops when nobody buys the next hour. That is the single fact a visitor has
 * to understand before anything else on the page means anything, and it is
 * not a fact a paragraph teaches well.
 *
 * So the meter is pressable and nothing else on the page moves. Paying lights
 * another interval; letting it run out darkens every interval and says what
 * actually happened — the workload stopped, nobody cancelled it, and nothing
 * further was owed. There is no timer: ambient motion would make it a toy,
 * and a visitor who has not touched it has seen a still diagram.
 *
 * The numbers are the devnet provider's real ones, the same ones the listings
 * table further down publishes.
 */

/** Intervals this drawing has room for. A real lease has no ceiling. */
const SLOTS = 12;

/** The devnet `basic` listing: what one lease interval costs. */
const PRICE = '1000 µUSDC';

export function LeaseMeter() {
  const [paid, setPaid] = useState(2);
  const [expired, setExpired] = useState(false);

  const full = paid >= SLOTS;
  const hours = paid === 1 ? '1 hour' : `${paid} hours`;

  return (
    <figure className="meter">
      <p className="meter-title">
        <b>One lease, an hour at a time</b>
        <span>the devnet provider&rsquo;s own prices</span>
      </p>

      <div
        className="scale"
        role="img"
        aria-label={
          expired
            ? `Expired after ${hours}.`
            : `${paid} of ${SLOTS} intervals paid for, one hour each.`
        }
      >
        {Array.from({ length: SLOTS }, (_, at) => (
          <span key={at} className={at >= paid ? undefined : expired ? 'spent' : 'paid'} />
        ))}
      </div>

      <dl className="readout" aria-live="polite">
        <div>
          <dt>Paid</dt>
          <dd>
            {paid} × {PRICE}
          </dd>
        </div>
        <div>
          <dt>{expired ? 'Ran for' : 'Runs for'}</dt>
          <dd className={expired ? 'gone' : undefined}>{expired ? 'expired' : hours}</dd>
        </div>
        <div>
          <dt>What the provider knows about you</dt>
          <dd className="quiet">nothing</dd>
        </div>
      </dl>

      <div className="meter-controls">
        {expired ? (
          <button
            type="button"
            className="pay"
            onClick={() => {
              setPaid(1);
              setExpired(false);
            }}
          >
            take a new lease
          </button>
        ) : (
          <>
            <button
              type="button"
              className="pay"
              disabled={full}
              onClick={() => setPaid((count) => Math.min(count + 1, SLOTS))}
            >
              pay {PRICE}, get an hour
            </button>
            <button type="button" onClick={() => setExpired(true)}>
              stop paying
            </button>
          </>
        )}
      </div>

      <figcaption className="meter-note">
        {expired
          ? 'The workload stopped when the last interval ran out. Nobody cancelled it, nothing further was owed, and no account was closed.'
          : full
            ? 'Twelve is as far as this drawing goes. A real lease runs as long as somebody keeps extending it.'
            : 'A drawing, not a live lease. A real payment is a sealed packet on a channel, and it clears in the time it takes to send one.'}
      </figcaption>
    </figure>
  );
}
