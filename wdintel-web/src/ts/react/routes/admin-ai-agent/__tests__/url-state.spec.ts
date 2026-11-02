/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it } from 'vitest';

import { readAiAgentRequestDeepLink, writeAiAgentRequestDeepLink } from '../url-state';

describe('AI request deep links', () => {
  afterEach(() => window.history.replaceState({}, '', '/admin/ai/requests'));

  it('writes and clears the selected request without dropping other parameters', () => {
    window.history.replaceState({}, '', '/admin/ai/requests?tab=x');
    const length = window.history.length;

    writeAiAgentRequestDeepLink('request-1');
    expect(readAiAgentRequestDeepLink()).toBe('request-1');
    expect(new URLSearchParams(window.location.search).get('tab')).toBe('x');

    writeAiAgentRequestDeepLink('request-1');
    expect(window.history.length).toBe(length + 1);

    writeAiAgentRequestDeepLink(null);
    expect(readAiAgentRequestDeepLink()).toBeNull();
    expect(window.location.search).toBe('?tab=x');
  });
});
