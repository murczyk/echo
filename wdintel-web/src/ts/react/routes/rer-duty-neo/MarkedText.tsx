import React from 'react';

import type { ContentNode } from '../../../../Bindings';
import { buildAnalysisMapHrefWithSearch } from './utils';

/**
 * Renders backend-produced marked content (callsigns, keywords, signals, points)
 * when highlight_* request params are used.
 */
function collectPointEtalons(nodes: ContentNode[]): string[] {
  const etalons: string[] = [];
  for (const n of nodes) {
    if (typeof n !== 'string' && 'CNPointC' in n && n.CNPointC?.etalon != null) {
      const e = String(n.CNPointC.etalon).trim();
      if (e !== '') etalons.push(e);
    }
  }
  return etalons;
}

/**
 * @param messagePointEtalons - When provided (e.g. from msg.pointTokens), use for map href so all points from the message are in the search. Falls back to etalons from nodes when not provided.
 */
export function renderMarkedText(
  nodes: ContentNode[],
  bodyText: string,
  messagePointEtalons?: string[],
): React.ReactNode[] {
  const fromNodes = collectPointEtalons(nodes);
  const allPointEtalons =
    messagePointEtalons != null && messagePointEtalons.length > 0 ? messagePointEtalons : fromNodes;
  return nodes.map((node, i) => {
    if (typeof node === 'string') {
      if (node === 'CNNewlineC') return <br key={i} />;
      return null;
    }
    if ('CNTextC' in node) {
      return <span key={i}>{node.CNTextC.text}</span>;
    }
    if ('CNCallsignC' in node) {
      const { text } = node.CNCallsignC;
      const href = `/rer-callsigns?callsign=${encodeURIComponent(text)}`;
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="content-token--ADP hover:cursor-pointer"
        >
          {text}
        </a>
      );
    }
    if ('CNHighlightC' in node) {
      const { text } = node.CNHighlightC;
      return (
        <span key={i} className="badge-highlighed-token badge-highlighed-token--callsign">
          {text}
        </span>
      );
    }
    if ('CNSignalC' in node) {
      const { text } = node.CNSignalC;
      return (
        <span key={i} className="content-token--ADV">
          {text}
        </span>
      );
    }
    if ('CNPointC' in node) {
      const { begin, end, etalon } = node.CNPointC;
      const sliceText = bodyText.slice(begin, end);
      const etalonsForUrl = allPointEtalons.length > 0 ? allPointEtalons : [etalon];
      const href = buildAnalysisMapHrefWithSearch(etalonsForUrl);
      const title =
        allPointEtalons.length > 1
          ? `Відкрити на мапі аналізу: ${allPointEtalons.join(', ')}`
          : `Відкрити на мапі аналізу: ${etalon}`;
      return (
        <a
          key={i}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="content-token--point content-token--point-link badge-highlighed-token"
          title={title}
          style={{ cursor: 'pointer', display: 'inline-block', pointerEvents: 'auto', zIndex: 100 }}
        >
          {sliceText}
        </a>
      );
    }
    return null;
  });
}
