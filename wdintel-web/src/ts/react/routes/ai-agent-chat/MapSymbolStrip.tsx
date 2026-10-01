import type { AiAgentMapRecord } from '../../../../Bindings';
import { symbolImage } from './map-symbol';

const STRIP_LIMIT = 4;

/** The most frequent symbols of a map, for its chat preview card. */
export default function MapSymbolStrip({ records }: { records: AiAgentMapRecord[] }) {
  const counts = new Map<string, number>();
  for (const record of records) counts.set(record.sidc, (counts.get(record.sidc) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, STRIP_LIMIT);
  const rest = counts.size - top.length;
  return (
    <span className="ai-map-symbol-strip" aria-hidden="true">
      {top.map(([sidc, count]) => {
        const image = symbolImage(sidc, 14);
        return (
          <span key={sidc}>
            <img src={image.url} width={image.width} height={image.height} alt="" />
            {count}
          </span>
        );
      })}
      {rest > 0 ? <span>+{rest}</span> : null}
    </span>
  );
}
