import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFileCitations, deviceRequest, fileCitationHref, prepareFileCitations, stripUnknownFileCitations } from './devices.ts';
import { compactToolResponse, validateSkill } from './runner.ts';
import { sanitizeEditOperations } from './maps.ts';

const source = { deviceId: '01999999-1111-7111-8111-111111111111', fileId: '01999999-2222-7222-8222-222222222222', revision: 3, extractionRevision: '01999999-3333-7333-8333-333333333333', section: null };
const document = { ...source, fileName: 'orders.zip', citation: fileCitationHref(source) };

test('#3064 device tools accept only read routes and bounded selectors', () => {
  assert.throws(() => deviceRequest('deviceFileRead', { ...source, fileId: '../secrets' }));
  assert.throws(() => deviceRequest('deviceFileSearch', { query: 'positions', limit: 10000 }));
  assert.throws(() => deviceRequest('deviceFileSearch', { url: 'http://localhost' }));
  assert.throws(() => validateSkill({ method: 'POST', path: '/api/admin/device-documents/settings', skill: 'device_file_search', label: 'Search', requestKind: 'deviceFileSearch' }));
  assert.deepEqual(deviceRequest('deviceGet', { deviceId: source.deviceId }), { device_id: source.deviceId, include_archived: false });
  assert.deepEqual(deviceRequest('deviceFileSearch', { query: 'позиції', history: true, scope: 'content', limit: 5 }), { query: 'позиції', history: true, scope: 'content', limit: 5 });
});

test('#3064 file sections retain exact source revisions and continuation under compaction', () => {
  const body = prepareFileCitations({ document, sections: [0, 1, 2].map((ordinal) => ({ ordinal, member: 'report.xlsx', locator: `row ${ordinal}`, text: 'x'.repeat(2000), markdown: 'x'.repeat(2000), html: '<p>redundant</p>' })), nextAfter: null });
  const compacted = compactToolResponse({ skill: 'device_file_read', requestKind: 'deviceFileRead' }, body, 64, 3200);
  const result = JSON.parse(compacted);
  assert.equal(result.document.extractionRevision, source.extractionRevision);
  assert.equal(result.sections.length, 1);
  assert.equal(result.nextAfter, 0);
  assert.equal(result.sections[0].markdown.length, 2000);
  assert.equal(result.sections[0].citation, fileCitationHref({ ...source, section: 0 }));
  assert.equal(collectFileCitations(result).length, 2);
  const inspection = prepareFileCitations({ result: { document, sections: [{ ordinal: 1 }] } });
  assert.equal(collectFileCitations(inspection).length, 2);
});

test('#3064 file search compaction rebuilds a revision keyset cursor', () => {
  const documents = [1, 2, 3].map((revision) => ({ ...document, revision, summary: 'x'.repeat(1800) }));
  const result = JSON.parse(compactToolResponse({ skill: 'device_file_search', requestKind: 'deviceFileSearch' }, { documents, nextCursor: null }, 64, 1000));
  assert.equal(result.documents.length, 1);
  assert.deepEqual(JSON.parse(Buffer.from(result.nextCursor, 'base64url').toString()), [source.fileId, 1]);
  assert.match(result.warnings[0], /Showing 1 of 3 hits to fit context; follow nextCursor/);
});

// Regression: https://github.com/echoua/echo/issues/4224
const searchHit = (index: number, overrides: Record<string, unknown> = {}) => {
  const hit = { ...source, fileId: `01999999-2222-7222-8222-${String(index).padStart(12, '0')}`, extractionRevision: null };
  return {
    ...hit, fileName: `KMSAuto-${index}.exe`, path: `C:\\Users\\operator\\Downloads\\Activators\\KMSAuto-${index}.exe`, format: 'exe',
    modifiedAt: 1_790_000_000_000, current: true, hasContent: true, state: 'completed', complete: true,
    summary: 'Активатор Windows і Office. '.repeat(70), summaryState: 'completed', positionState: 'completed',
    snippet: 'page 1: ' + 'KMS activation text '.repeat(30), citation: fileCitationHref({ ...hit, section: null }), ...overrides,
  };
};

test('#4224 file search hits drop defaults and halve their size without losing citations', () => {
  const documents = Array.from({ length: 50 }, (_, index) => searchHit(index));
  const body = { documents, nextCursor: null };
  const text = compactToolResponse({ skill: 'device_file_search', requestKind: 'deviceFileSearch' }, body, 64, 96_000);
  assert.ok(text.length * 2 <= JSON.stringify(body).length, `${text.length} vs ${JSON.stringify(body).length}`);
  const [hit] = JSON.parse(text).documents;
  assert.equal(hit.folder, 'C:\\Users\\operator\\Downloads\\Activators');
  for (const omitted of ['path', 'format', 'current', 'hasContent', 'state', 'complete', 'summaryState', 'positionState', 'extractionRevision'])
    assert.ok(!(omitted in hit), omitted);
  assert.deepEqual(Object.keys(hit).filter((key) => ['deviceId', 'fileId', 'revision', 'citation'].includes(key)).length, 4);
  assert.deepEqual(collectFileCitations(body).filter((citation) => text.includes(fileCitationHref(citation))).length, 50);
});

test('#4224 file search hits keep non-default states for honest coverage', () => {
  const documents = [
    searchHit(1, { state: 'content_unavailable', hasContent: false, complete: false, summary: null, summaryState: 'pending', snippet: null }),
    searchHit(2, { current: false, complete: false, summaryState: 'failed', format: 'bin' }),
  ];
  const [unavailable, partial] = JSON.parse(compactToolResponse({ skill: 'device_file_search', requestKind: 'deviceFileSearch' }, { documents, nextCursor: null }, 64, 96_000)).documents;
  assert.equal(unavailable.state, 'content_unavailable');
  assert.ok(!('hasContent' in unavailable) && !('summaryState' in unavailable) && !('summary' in unavailable));
  assert.equal(partial.current, false);
  assert.equal(partial.complete, false);
  assert.equal(partial.summaryState, 'failed');
  assert.equal(partial.format, 'bin');
});

test('#4224 file search hits shorten texts before dropping hits', () => {
  const documents = Array.from({ length: 20 }, (_, index) => searchHit(index));
  const result = JSON.parse(compactToolResponse({ skill: 'device_file_search', requestKind: 'deviceFileSearch' }, { documents, nextCursor: 'server' }, 64, 16_000));
  assert.equal(result.documents.length, 20);
  assert.equal(result.nextCursor, 'server');
  assert.ok(result.documents.every((hit: any) => hit.summary.length <= 300 && hit.summary.endsWith('…')));
  assert.equal(result.warnings, undefined);
});

test('#3064 file citations cannot be forged in prose or map edits', () => {
  const href = fileCitationHref(source);
  assert.equal(stripUnknownFileCitations(`[report](${href})`, [source]), `[report](${href})`);
  assert.doesNotMatch(stripUnknownFileCitations(`[report](${href.replace('revision=3', 'revision=4')})`, [source]), /\]\(/);
  const fake = { ...source, revision: 4 };
  const record = { name: 'Point', x: '1234567', y: '7654321', coordinateSystem: 'sk42', fileSources: [source, fake] };
  const [edit] = sanitizeEditOperations([{ op: 'add', record }], [], () => false, 64, (citation) => fileCitationHref(citation) === href) as any[];
  assert.deepEqual(edit.record.fileSources, [source]);
  assert.deepEqual(collectFileCitations({ document: { ...document, citation: `${href}bad` } }), []);
});

test('#3064 position compaction retains valid evidence references and canonical citations', () => {
  const mentions = [1, 2, 3].map((revision) => {
    const reference = { ...source, revision };
    return { source: reference, citation: fileCitationHref(reference), context: 'x'.repeat(1200) };
  });
  const result = JSON.parse(compactToolResponse({ skill: 'position_lookup', requestKind: 'positionLookup' }, {
    fileMentions: mentions, known: [], located: [], other: [],
    evidenceGroups: [{ knownIndexes: [], fileIndexes: [0, 1, 2] }], note: 'Undated evidence',
  }, 64, 2200));
  assert.equal(result.fileMentions.length, 1);
  assert.deepEqual(result.evidenceGroups, []);
  assert.equal(collectFileCitations(result).length, 1);
  assert.equal(result.truncated, true);
});


test('#3757 final citation cleanup retains registered file source links', async () => {
  const { chooseCitedAnswer } = await import('./citations.ts');
  const source = { deviceId: '01999999-1111-7111-8111-111111111111', fileId: '01999999-2222-7222-8222-222222222222', revision: 1 };
  const href = fileCitationHref(source);
  const draft = `Found losses.xlsx [джерело](${href}).`;
  assert.equal(chooseCitedAnswer(draft, null, [], [], [href]), draft);
  const message = { messageId: 7, messageIdentifier: 'message-seven' };
  const repair = `${draft} [джерело](/rer-analysis-neo?m=message-seven)`;
  assert.equal(chooseCitedAnswer(draft, repair, [message], [message], [href]), repair);
  assert.equal(chooseCitedAnswer('[джерело](/devices/forged?file=forged)', null, [], [], [href]), '');
});

test('#4224 a file at a filesystem root keeps its root folder', () => {
  const project = (path: string, fileName: string) => compactToolResponse({ skill: 'device_file_search', requestKind: 'deviceFileSearch' }, { documents: [{ ...document, fileName, path, state: 'completed' }], nextCursor: null }, 64, 96_000);
  assert.equal(JSON.parse(project('C:\\KMSAuto.exe', 'KMSAuto.exe')).documents[0].folder, 'C:\\');
  assert.equal(JSON.parse(project('/KMSAuto.exe', 'KMSAuto.exe')).documents[0].folder, '/');
  assert.equal(JSON.parse(project('C:\\Tools\\KMSAuto.exe', 'KMSAuto.exe')).documents[0].folder, 'C:\\Tools');
});
