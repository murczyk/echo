import React from 'react';

import type { ContentNode } from '../../../../Bindings';

/**
 * Renders backend-produced marked content (callsigns, keywords, signals, points)
 * when highlight_* request params are used. Uses same CSS classes as Elm MarkedText
 * so existing styles apply.
 */
export function renderMarkedText(
  nodes: ContentNode[],
  bodyText: string,
): React.ReactNode[] {
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
      const { begin, end } = node.CNPointC;
      const sliceText = bodyText.slice(begin, end);
      return (
        <span key={i} className="content-token--point badge-highlighed-token">
          {sliceText}
        </span>
      );
    }
    return null;
  });
}
