import { useLayoutEffect } from 'react';

export function useAttachmentPreviewEdgeToEdge(enabled: boolean) {
  useLayoutEffect(() => {
    if (!enabled) return;
    const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    if (!viewport) return;
    const content = viewport.content;
    const directives = content
      .split(',')
      .filter((directive) => !/^\s*viewport-fit\s*=/i.test(directive));
    viewport.content = [...directives, 'viewport-fit=cover'].join(',');
    return () => {
      viewport.content = content;
    };
  }, [enabled]);
}
