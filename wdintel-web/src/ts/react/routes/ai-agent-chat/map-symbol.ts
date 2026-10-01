import * as milsymbol from 'milsymbol';

// Imported only from lazily loaded map chunks: milsymbol is large.
// The package is CommonJS without a typed default export.
const ms = ((milsymbol as unknown as { default?: typeof milsymbol }).default ??
  milsymbol) as typeof milsymbol;

export type SymbolImage = {
  url: string;
  width: number;
  height: number;
  anchorX: number;
  anchorY: number;
};

const cache = new Map<string, SymbolImage>();

export function identityColor(sidc: string): string {
  switch (sidc[3]) {
    case '2':
      return '#80e0ff';
    case '3':
      return '#00a8dc';
    case '4':
      return '#00a651';
    case '5':
    case '6':
      return '#ff0000';
    default:
      return '#ffff00';
  }
}

function identitySymbol(sidc: string, size: number): SymbolImage {
  const color = identityColor(sidc);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" fill="${color}" stroke="#000" stroke-width="4"/><text x="32" y="42" text-anchor="middle" font-size="26" font-family="sans-serif">?</text></svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    width: size,
    height: size,
    anchorX: size / 2,
    anchorY: size / 2,
  };
}

/** Draws any APP-6(D) SIDC; codes milsymbol rejects get an identity-colored
 * frame so a typo stays visible instead of looking like a valid symbol. */
export function symbolImage(sidc: string, size = 24): SymbolImage {
  const key = `${sidc}:${size}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const symbol = new ms.Symbol(sidc, { size, simpleStatusModifier: true });
  const image = symbol.isValid()
    ? (() => {
        const dimensions = symbol.getSize();
        const anchor = symbol.getAnchor();
        return {
          url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(symbol.asSVG())}`,
          width: dimensions.width,
          height: dimensions.height,
          anchorX: anchor.x,
          anchorY: anchor.y,
        };
      })()
    : identitySymbol(sidc, size);
  cache.set(key, image);
  return image;
}

export function isDrawableSidc(sidc: string): boolean {
  return /^\d{20}$/.test(sidc) && Boolean(new ms.Symbol(sidc).isValid());
}

/** PNG bytes (base64) for KMZ export; Google Earth does not read SVG icons. */
export function symbolPngBase64(sidc: string, size = 40): string | null {
  const symbol = new ms.Symbol(sidc, { size });
  if (!symbol.isValid()) return null;
  try {
    const dataUrl = symbol.asCanvas().toDataURL('image/png');
    const [, base64 = ''] = dataUrl.split(',', 2);
    return base64 || null;
  } catch {
    return null;
  }
}
