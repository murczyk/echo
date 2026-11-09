/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it } from 'vitest';

import { writeConversationUrl } from '../conversation-url';

const CONVERSATION_ID = '01a1a175-c5a0-7ec2-a535-6d249130a346';

describe('writeConversationUrl', () => {
  afterEach(() => {
    window.history.replaceState({}, '', '/');
  });

  // Regression: https://github.com/echoua/echo/issues/3992
  it('keeps only the conversation param on the home URL', () => {
    window.history.replaceState(
      {},
      '',
      '/?fromDateTime=2026-11-03T00%3A00&toDateTime=2026-11-04T00%3A00&leftPanelOpen=false',
    );

    writeConversationUrl(CONVERSATION_ID);
    expect(`${window.location.pathname}${window.location.search}`).toBe(
      `/?conversation=${CONVERSATION_ID}`,
    );

    writeConversationUrl(null);
    expect(`${window.location.pathname}${window.location.search}`).toBe('/');
  });

  it('does not write after navigation has left the home route', () => {
    window.history.replaceState({}, '', '/rer-analysis-neo?freqs=111.1');

    writeConversationUrl(null, true);

    expect(`${window.location.pathname}${window.location.search}`).toBe(
      '/rer-analysis-neo?freqs=111.1',
    );
  });
});
