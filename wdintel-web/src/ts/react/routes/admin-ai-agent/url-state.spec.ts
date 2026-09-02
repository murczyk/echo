import { describe, expect, it } from 'vitest';

import { readAiAgentRequestDeepLink } from './url-state';

describe('readAiAgentRequestDeepLink', () => {
  it('reads and decodes the Mattermost request link', () => {
    expect(readAiAgentRequestDeepLink('?requestId=019fc7f7-9770-7f83-9c1a-211af29b02e6')).toBe(
      '019fc7f7-9770-7f83-9c1a-211af29b02e6',
    );
  });

  it('ignores absent and empty request IDs', () => {
    expect(readAiAgentRequestDeepLink('')).toBeNull();
    expect(readAiAgentRequestDeepLink('?requestId=%20')).toBeNull();
  });
});
