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
  const result = JSON.parse(compactToolResponse({ skill: 'device_file_search', requestKind: 'deviceFileSearch' }, { documents, nextCursor: null }, 64, 2600));
  assert.equal(result.documents.length, 1);
  assert.deepEqual(JSON.parse(Buffer.from(result.nextCursor, 'base64url').toString()), [source.fileId, 1]);
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
