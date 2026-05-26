import { describe, expect, it } from 'vitest';

import { getPointPopupTemplate } from './popup-template';
import type { Message, NetworkUnit } from './types';

function buildMessage(overrides: Partial<Message[1]> = {}): Message {
  return [
    42,
    {
      text: 'plain text',
      ...overrides,
    },
  ];
}

describe('getPointPopupTemplate', () => {
  it('renders marked point tokens with a peleng tooltip title', () => {
    const message = buildMessage({
      text_marked: [
        { CNTextC: { text: 'Оріон ' } },
        { CNPointC: { text: 'P-1', etalon: 'P-1', begin: 0, end: 3 } },
      ] as unknown as Message[1]['text_marked'],
    });

    const html = getPointPopupTemplate([message], [] as NetworkUnit[], []);

    expect(html).toContain('Оріон');
    expect(html).toContain('P-1');
    expect(html).toContain('title="Відкрити на мапі аналізу: P-1"');
  });

  it('renders callsign tokens from marked popup text', () => {
    const message = buildMessage({
      text_marked: [{ CNCallsignC: { text: 'БОРОДА', begin: 0, end: 6, etalon: 'БОРОДА' } }] as unknown as Message[1]['text_marked'],
    });

    const html = getPointPopupTemplate([message], [] as NetworkUnit[], []);

    expect(html).toContain('БОРОДА');
    expect(html).toContain('badge-highlighed-token--callsign');
  });

  it('shows the selected icon for canonical empty unit selections', () => {
    const message = buildMessage({
      unit: 'Не визначено',
    });

    const html = getPointPopupTemplate([message], [] as NetworkUnit[], ['']);

    expect(html).toContain('Не визначено');
    expect(html).toContain('bi-dash-square');
  });
});
