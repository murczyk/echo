import { useEffect, useRef } from 'react';

import { prewarmAiAgent } from '../../services/api/ai-agent';

/** At most one prewarm per minute while the user keeps typing (#4139). */
export const PREWARM_INTERVAL_MS = 60_000;

/**
 * Starts the user's agent container while they compose a message, so the
 * request that follows skips most of the "Готую середовище" wait (#4139).
 *
 * Fires on the first draft text or attachment, then again only when the
 * draft keeps changing at least a minute later, so a draft left in a
 * background tab lets the container stop. Never fires on focus or page load.
 */
export function usePrewarmWhileComposing({
  draft,
  attachmentCount,
  providerId,
  enabled,
}: {
  draft: string;
  attachmentCount: number;
  providerId: string;
  enabled: boolean;
}) {
  const lastSentAtRef = useRef<number | null>(null);
  const composing = draft.trim() !== '' || attachmentCount > 0;

  useEffect(() => {
    if (!composing || !enabled || !providerId) return;
    const now = Date.now();
    const lastSentAt = lastSentAtRef.current;
    if (lastSentAt !== null && now - lastSentAt < PREWARM_INTERVAL_MS) return;
    lastSentAtRef.current = now;
    void prewarmAiAgent(providerId).catch(() => undefined);
  }, [draft, attachmentCount, composing, enabled, providerId]);
}
