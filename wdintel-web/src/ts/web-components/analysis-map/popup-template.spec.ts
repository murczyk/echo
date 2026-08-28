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

    const html = getPointPopupTemplate([message], []);

    expect(html).toContain('Оріон');
    expect(html).toContain('P-1');
    expect(html).toContain('title="Відкрити на мапі аналізу: P-1"');
  });

  it('renders callsign tokens from marked popup text', () => {
    const message = buildMessage({
      text_marked: [
        { CNCallsignC: { text: 'БОРОДА', begin: 0, end: 6, etalon: 'БОРОДА' } },
      ] as unknown as Message[1]['text_marked'],
    });

    const html = getPointPopupTemplate([message], []);

    expect(html).toContain('БОРОДА');
    expect(html).toContain('badge-highlighed-token--callsign');
  });

  it('prefers the message unit over a network-unit guess', () => {
    const message = buildMessage({
      freq: '145.5',
      network_ids: [1],
      unit: 'Header Unit',
    });

    const html = getPointPopupTemplate([message], []);

    expect(html).toContain('Header Unit');
    expect(html).not.toContain('Unit A');
  });

  it('filters by the displayed unit when one unrelated canonical unit is linked', () => {
    const message = buildMessage({ unit: 'Header Unit', unit_ids: [17] });

    const html = getPointPopupTemplate([message], ['Header Unit']);

    expect(html).toContain('data-unitname="Header Unit"');
    expect(html).toContain('Header Unit');
    expect(html).toContain('bi-dash-square');
  });

  it('filters by the displayed unit when several canonical units are linked', () => {
    const message = buildMessage({ unit: 'Header Unit', unit_ids: [11, 17] });

    const html = getPointPopupTemplate([message], ['Header Unit']);

    expect(html).toContain('data-unitname="Header Unit"');
    expect(html).toContain('bi-dash-square');
  });

  it('shows an undefined unit when the message unit is missing', () => {
    const message = buildMessage({
      freq: '145.5',
      network_ids: [1],
    });

    const html = getPointPopupTemplate([message], []);

    expect(html).toContain('Не визначено');
    expect(html).not.toContain('Unit A');
  });

  it('shows the selected icon for legacy undefined unit selections', () => {
    const message = buildMessage({
      unit: 'Не визначено',
    });

    const html = getPointPopupTemplate([message], ['Не визначено']);

    expect(html).toContain('bi-dash-square');
  });

  it('renders the selected peleng Battle Line distance in kilometers', () => {
    const message = buildMessage({ coords: '50.255433, 36.915901' });

    const html = getPointPopupTemplate([message], [], false, undefined, new Map([[42, 12_567]]));

    expect(html).toContain('Відстань до ЛБЗ:</span> 12.57км');
  });
});
