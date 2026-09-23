import type { GatewayProbe, ProbeAnswer } from './gateway.js';

/**
 * Knocking on a workload's hostname, for real (TOON_Network#97, spec §12.3).
 *
 * The live half of `gateway.ts`'s probe port, and the only thing in the
 * console that speaks to a workload rather than about one. It is an ordinary
 * HTTPS `GET /` — no TOON packet, no seal, no channel, nothing paid — because
 * the question it answers is the one a person actually has: *does the URL
 * work?* Every other signal the console can show is a report from an
 * interested party.
 *
 * Three things it does, and no more.
 *
 * **It never follows a redirect.** A workload that answers `302` to somewhere
 * else has answered, and that is the fact to report; chasing the redirect
 * would turn this console into an HTTP client on somebody else's behalf and
 * could walk it straight off the gateway's domain.
 *
 * **It reads §12.3's reason from the header first.** A gateway that is not
 * serving a hostname answers `503` with `toon-gateway-reason` and a two-key
 * body. Reading the header rather than parsing the body is what lets this tell
 * a gateway's refusal from a *workload's own* `503` — a workload may answer
 * anything it likes, and a workload answering `503` is still the workload
 * answering, which is exactly what a person handed it over to have happen.
 *
 * **It keeps only a short excerpt.** Enough for somebody to recognise their
 * own app — a title, the first line of a JSON body — and deliberately not
 * enough to be a proxy. The body is somebody's own workload and this console
 * has no business storing it.
 */

/** §12.3's own header. The gateway sets it beside the body's `error`. */
const REASON_HEADER = 'toon-gateway-reason';

/** How much of the answer is kept, in characters. A recognisable amount. */
const EXCERPT = 300;

export class LiveGatewayProbe implements GatewayProbe {
  readonly #timeoutMs: number;

  constructor(options: { timeoutMs?: number } = {}) {
    // Short, because this is a page load and a person is watching it. A
    // hostname that has not answered in ten seconds has answered.
    this.#timeoutMs = options.timeoutMs ?? 10_000;
  }

  async knock(url: string, options: { timeoutMs?: number } = {}): Promise<ProbeAnswer> {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: '*/*' },
      signal: AbortSignal.timeout(options.timeoutMs ?? this.#timeoutMs),
    });
    const header = response.headers.get(REASON_HEADER);
    const text = await response.text().catch(() => '');
    return {
      status: response.status,
      ...(header === null ? reasonIn(text, response.status) : { reason: header }),
      ...(text.length === 0 ? {} : { excerpt: excerptOf(text) }),
    };
  }
}

/**
 * A §12.3 reason read out of the body, for a gateway that set no header.
 *
 * Only ever on a `503`, and only when the body is the two-key error shape §5
 * fixes. Anything looser would read a *workload's* own `{"error": …}` as its
 * gateway refusing to serve it, which is the one confusion this whole module
 * exists to avoid.
 */
function reasonIn(text: string, status: number): { reason?: string } {
  if (status !== 503) return {};
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const keys = Object.keys(body);
    if (
      typeof body['error'] === 'string' &&
      keys.length <= 2 &&
      keys.every((key) => key === 'error' || key === 'message')
    ) {
      return { reason: body['error'] };
    }
  } catch {
    // Not JSON: a workload's own page, or an error page from something in
    // front of it. Either way it is not a gateway reason.
  }
  return {};
}

function excerptOf(text: string): string {
  const flattened = text.replace(/\s+/gu, ' ').trim();
  return flattened.length > EXCERPT ? `${flattened.slice(0, EXCERPT)}…` : flattened;
}
