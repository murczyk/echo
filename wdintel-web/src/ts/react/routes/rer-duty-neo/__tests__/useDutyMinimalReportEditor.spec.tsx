/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { useDutyMinimalReportEditor } from '../useDutyMinimalReportEditor';

type Options = Parameters<typeof useDutyMinimalReportEditor>[0];

const baseOptions: Options = {
  enabled: true,
  reportIntent: true,
  editorIntentKey: 'create-report:1',
  sourceFeedId: 'feed-2',
  feedIdsKey: 'feed-1,feed-2',
};

let latest: ReturnType<typeof useDutyMinimalReportEditor>;
let root: Root;
let columns: HTMLElement;

function Probe(options: Options) {
  latest = useDutyMinimalReportEditor(options);
  return null;
}

function render(options: Partial<Options> = {}) {
  act(() => root.render(createElement(Probe, { ...baseOptions, ...options })));
}

function addColumn(feedId: string) {
  const column = document.createElement('div');
  column.setAttribute('data-duty-feed-column', '');
  column.dataset.dutyFeedId = feedId;
  columns.append(column);
  return column;
}

beforeEach(() => {
  columns = document.createElement('div');
  document.body.append(columns);
  root = createRoot(document.createElement('div'));
});

afterEach(() => {
  act(() => root.unmount());
  columns.remove();
});

describe('useDutyMinimalReportEditor', () => {
  it('hosts the panel on the source column and follows a new source', () => {
    const first = addColumn('feed-1');
    const second = addColumn('feed-2');

    render();
    expect(latest.active).toBe(true);
    expect(latest.host).toBe(second);

    render({ sourceFeedId: 'feed-1', editorIntentKey: 'create-report:2' });
    expect(latest.host).toBe(first);
  });

  it('moves to a remaining column when the source column is removed', () => {
    const first = addColumn('feed-1');
    const second = addColumn('feed-2');
    render();

    second.remove();
    render({ feedIdsKey: 'feed-1' });

    expect(latest.host).toBe(first);
  });

  it.each([
    ['the preference is off', { enabled: false }],
    ['the intent is not a report', { reportIntent: false }],
    ['the editor is closed', { editorIntentKey: null }],
  ])('stays inactive when %s', (_, options) => {
    addColumn('feed-2');

    render(options);

    expect(latest.active).toBe(false);
    expect(latest.host).toBeNull();
  });

  it('expands only the current report and starts minimal again afterwards', () => {
    addColumn('feed-2');
    render();

    act(() => latest.expand());
    expect(latest.active).toBe(false);
    expect(latest.host).toBeNull();

    render({ editorIntentKey: 'create-report:2' });
    expect(latest.active).toBe(true);

    render();
    expect(latest.active).toBe(true);
  });

  it('forgets an expansion once the editor closes', () => {
    addColumn('feed-2');
    render();
    act(() => latest.expand());

    render({ editorIntentKey: null, reportIntent: false });
    render();

    expect(latest.active).toBe(true);
  });
});
