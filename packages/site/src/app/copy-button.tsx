import { useState } from 'react';

/**
 * Copy the command beside it.
 *
 * The install section's whole job is to get a line into a terminal, and a
 * visitor who has to select three lines of shell by hand is being asked to do
 * the one thing a page can do for them. `navigator.clipboard` is absent under
 * plain HTTP and in jsdom, so the button hides itself rather than failing when
 * pressed.
 */
export function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);
  if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return null;
  return (
    <button
      type="button"
      className="copy"
      aria-label={`Copy ${what}`}
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
