/**
 * The wordmark, drawn on the page's grid.
 *
 * The letters are a seven-row bitmap face set as one square per pixel — the
 * same square the dither behind the page is made of, and the same square a
 * paid interval is drawn as in the meter below. At the right-hand end the
 * letters come apart into that dither, which is the whole idea stated in one
 * picture: the name and the texture are the same material.
 *
 * Nothing here is random at runtime. Which pixel dims and which one comes
 * loose is a hash of its position, so the banner is identical on every render
 * and in every browser.
 */

const GLYPHS: Record<string, readonly string[]> = {
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  N: ['10001', '11001', '11001', '10101', '10011', '10011', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '01010'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

const WORD = 'TOON NETWORK';
const CHAR_W = 5;
const CHAR_H = 7;
const GAP = 1;
const WIDTH = WORD.length * (CHAR_W + GAP) - GAP;

/** A stable number in [0, 1) for a cell, so the same pixel always decides the same way. */
function noise(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

interface Pixel {
  readonly x: number;
  readonly y: number;
  readonly o: number;
}

function pixels(): Pixel[] {
  const out: Pixel[] = [];
  const taken = new Set<string>();
  const put = (pixel: Pixel) => {
    const at = `${pixel.x}:${pixel.y}`;
    if (taken.has(at)) return;
    taken.add(at);
    out.push(pixel);
  };
  // Where the letters start to come apart. Late enough that the name is read
  // before it is felt: a wordmark you cannot read is not a wordmark.
  const edge = WIDTH * 0.96;
  for (let at = 0; at < WORD.length; at += 1) {
    const rows = GLYPHS[WORD[at] ?? ' '] ?? GLYPHS[' '];
    const left = at * (CHAR_W + GAP);
    for (let row = 0; row < CHAR_H; row += 1) {
      for (let col = 0; col < CHAR_W; col += 1) {
        if (rows?.[row]?.[col] !== '1') continue;
        const x = left + col;
        const erosion = Math.max(0, (x - edge) / (WIDTH - edge));
        if (noise(x, row) < erosion * 0.34) continue;
        put({ x, y: row, o: 0.7 + noise(x + 7, row + 3) * 0.3 });
      }
    }
  }
  // What came loose lands past the end of the word, thinning as it goes.
  for (let x = Math.floor(edge); x < WIDTH + 10; x += 1) {
    for (let y = -2; y < CHAR_H + 2; y += 1) {
      const reach = (x - edge) / (WIDTH - edge + 10);
      if (noise(x + 31, y + 17) > 0.16 - reach * 0.1) continue;
      put({ x, y, o: 0.22 + noise(x, y) * 0.28 });
    }
  }
  return out;
}

const PIXELS = pixels();

export function HeroBanner() {
  return (
    <svg
      className="banner"
      viewBox={`0 -2 ${WIDTH + 9} ${CHAR_H + 4}`}
      role="img"
      aria-label="TOON Network"
      shapeRendering="crispEdges"
    >
      {PIXELS.map((pixel) => (
        <rect
          key={`${pixel.x}:${pixel.y}`}
          x={pixel.x}
          y={pixel.y}
          width="1"
          height="1"
          fill="currentColor"
          opacity={pixel.o.toFixed(2)}
        />
      ))}
    </svg>
  );
}
