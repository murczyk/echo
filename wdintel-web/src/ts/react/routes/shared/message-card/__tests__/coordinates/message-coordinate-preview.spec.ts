/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentNode, InboxMessage, PalitraReadV2, Tag } from '../../../../../../../Bindings';
import {
  convertCoordinateToWgs84,
  extractCoordinates,
  renderWgsFloat,
  type ImporterCoordinate,
} from '../../../../importer-beta/coordinates';
import { listMapPalitrasV2, searchPalitraPoints } from '../../../../../services/api/palitra';
import { parseCoordinateInput } from '../../../../../../maps/coordinate-search';
import {
  primeCoordinatePreviewPalitraIds,
  resetCoordinatePreviewStateForTests,
  hasCoordinatePreviewCandidate,
  formatCoordinatePreviewPointCount,
  resolveMessageCoordinatePreview,
} from '../../message-coordinate-preview';

vi.mock('../../../../../services/api/palitra', () => ({
  listMapPalitrasV2: vi.fn(),
  searchPalitraPoints: vi.fn(),
}));

function createPalitra(id: number): PalitraReadV2 {
  return {
    palitra: {
      id,
    },
  } as PalitraReadV2;
}

function createMessage(overrides: Partial<InboxMessage>): InboxMessage {
  return {
    messageUid: null,
    text: '',
    media: [],
    images: [],
    imageRecognized: [],
    date: null,
    time: null,
    freq: null,
    coords: null,
    callsigns: [],
    callsignsAlg2: [],
    checked: false,
    important: false,
    bookmarked: false,
    timestamp: null,
    groupMasterKey: null,
    sender: null,
    extendedForm: null,
    messageComments: [],
    post: null,
    inboxTags: [],
    pointTokens: [],
    textMarked: [],
    ...overrides,
  } as InboxMessage;
}

const palitraTagsMap: Record<number, Tag> = {
  7: { isPalitra: true } as Tag,
};

describe('message coordinate preview resolver', () => {
  it.each([
    [1, '1 точка'],
    [2, '2 точки'],
    [3, '3 точки'],
    [9, '9 точок'],
  ])('formats %s coordinate points', (count, label) => {
    expect(formatCoordinatePreviewPointCount(count)).toBe(label);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetCoordinatePreviewStateForTests();
  });

  it('resolves direct WGS84 coordinates from msg.coords without loading palitras', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({ coords: '50.45044, 30.52355' }),
    });

    expect(result).toEqual({
      points: [
        {
          source: 'direct',
          lat: 50.45044,
          lng: 30.52355,
          label: '50.45044, 30.52355',
        },
      ],
      etalons: [],
      lookupError: null,
    });
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves direct WGS84 coordinates from message text before palitra lookup', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({ text: '50.45044, 30.52355' }),
    });

    expect(result?.points[0].source).toBe('direct');
    expect(result?.points[0].label).toBe('50.45044, 30.52355');
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves a compact preview USK pair and converts it to WGS84', async () => {
    const expected = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5268241,
      y: 6676046,
    } satisfies ImporterCoordinate);
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: '52-68241 66-76046',
      }),
    });

    expect(result?.lookupError).toBeNull();
    expect(result?.etalons).toEqual([]);
    expect(result?.points).toEqual([
      {
        source: 'direct',
        lat: expected!.lat,
        lng: expected!.lng,
        label: `${renderWgsFloat(expected!.lat)}, ${renderWgsFloat(expected!.lng)}`,
      },
    ]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves an exact labeled preview USK pair and converts it to WGS84', async () => {
    const expected = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5285002,
      y: 6682922,
    } satisfies ImporterCoordinate);
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'X = 5285002 Y = 6682922',
      }),
    });

    expect(result?.lookupError).toBeNull();
    expect(result?.etalons).toEqual([]);
    expect(result?.points).toEqual([
      {
        source: 'direct',
        lat: expected!.lat,
        lng: expected!.lng,
        label: `${renderWgsFloat(expected!.lat)}, ${renderWgsFloat(expected!.lng)}`,
      },
    ]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('rejects an unrelated bare preview USK pair that only looks numeric', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: '1234567 7654321',
      }),
    });

    expect(result).toBeNull();
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('rejects an unrelated labeled preview USK pair that only looks numeric', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'X=1234567 Y=7654321',
      }),
    });

    expect(result).toBeNull();
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves three preview USK pairs from a single message in source order', async () => {
    const points = [
      { x: 5268241, y: 6676046 },
      { x: 5268389, y: 6676122 },
      { x: 5268455, y: 6676062 },
    ] as const;
    const expectedPoints = points.map((point) => {
      const converted = convertCoordinateToWgs84({
        kind: 'usk2000',
        x: point.x,
        y: point.y,
      } satisfies ImporterCoordinate);
      expect(converted).not.toBeNull();
      return converted!;
    });

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: points.map((point) => `${point.x} ${point.y}`).join('\n'),
      }),
    });

    expect(result?.lookupError).toBeNull();
    expect(result?.etalons).toEqual([]);
    expect(result?.points).toHaveLength(3);
    expect(result?.points.map((point) => [point.lat, point.lng])).toEqual(
      expectedPoints.map((point) => [point.lat, point.lng]),
    );
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('does not reparse a matched preview USK span as another point', async () => {
    const primary = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5268241,
      y: 6676046,
    } satisfies ImporterCoordinate);
    const secondary = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5268389,
      y: 6676122,
    } satisfies ImporterCoordinate);
    expect(primary).not.toBeNull();
    expect(secondary).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'X=5268241 Y=6676046\n5268389 6676122',
      }),
    });

    expect(result?.lookupError).toBeNull();
    expect(result?.etalons).toEqual([]);
    expect(result?.points).toHaveLength(2);
    expect(result?.points.map((point) => [point.lat, point.lng])).toEqual([
      [primary!.lat, primary!.lng],
      [secondary!.lat, secondary!.lng],
    ]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves a bare preview USK pair followed by a labeled preview pair', async () => {
    const bare = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5283234,
      y: 6682213,
    } satisfies ImporterCoordinate);
    const labeled = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5285002,
      y: 6682922,
    } satisfies ImporterCoordinate);
    expect(bare).not.toBeNull();
    expect(labeled).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: '5283234 6682213\nX = 5285002 Y = 6682922',
      }),
    });

    expect(result?.lookupError).toBeNull();
    expect(result?.etalons).toEqual([]);
    expect(result?.points).toHaveLength(2);
    expect(result?.points.map((point) => [point.lat, point.lng])).toEqual([
      [bare!.lat, bare!.lng],
      [labeled!.lat, labeled!.lng],
    ]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves a slash-delimited labeled preview USK pair', async () => {
    const expected = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5285002,
      y: 6682922,
    } satisfies ImporterCoordinate);
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'X-5285002 / y-6682922',
      }),
    });

    expect(result?.lookupError).toBeNull();
    expect(result?.etalons).toEqual([]);
    expect(result?.points).toEqual([
      {
        source: 'direct',
        lat: expected!.lat,
        lng: expected!.lng,
        label: `${renderWgsFloat(expected!.lat)}, ${renderWgsFloat(expected!.lng)}`,
      },
    ]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves a Cyrillic-labeled preview USK pair', async () => {
    const expected = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5285002,
      y: 6682922,
    } satisfies ImporterCoordinate);
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'Х = 5285002 У = 6682922',
      }),
    });

    expect(result?.lookupError).toBeNull();
    expect(result?.etalons).toEqual([]);
    expect(result?.points).toEqual([
      {
        source: 'direct',
        lat: expected!.lat,
        lng: expected!.lng,
        label: `${renderWgsFloat(expected!.lat)}, ${renderWgsFloat(expected!.lng)}`,
      },
    ]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves a two-line bare preview USK pair', async () => {
    const expected = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5268241,
      y: 6676046,
    } satisfies ImporterCoordinate);
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: '5268241\n6676046',
      }),
    });

    expect(result?.lookupError).toBeNull();
    expect(result?.etalons).toEqual([]);
    expect(result?.points).toEqual([
      {
        source: 'direct',
        lat: expected!.lat,
        lng: expected!.lng,
        label: `${renderWgsFloat(expected!.lat)}, ${renderWgsFloat(expected!.lng)}`,
      },
    ]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves valid DMS coordinates from message text without loading palitras', async () => {
    const dmsCoordinate = extractCoordinates("50°27'13 30°31'24").find(
      (coordinate) => coordinate.kind === 'dms',
    );
    expect(dmsCoordinate?.kind).toBe('dms');
    const expected = convertCoordinateToWgs84(dmsCoordinate!);
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: "50°27'13 30°31'24",
      }),
    });

    expect(result?.points[0].source).toBe('direct');
    expect(result?.points[0]).toMatchObject({
      lat: expected!.lat,
      lng: expected!.lng,
    });
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves valid DMS coordinates from msg.coords without loading palitras', async () => {
    const dmsCoordinate = extractCoordinates("50°27'13 30°31'24").find(
      (coordinate) => coordinate.kind === 'dms',
    );
    expect(dmsCoordinate?.kind).toBe('dms');
    const expected = convertCoordinateToWgs84(dmsCoordinate!);
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        coords: "50°27'13 30°31'24",
      }),
    });

    expect(result?.points[0].source).toBe('direct');
    expect(result?.points[0]).toMatchObject({
      lat: expected!.lat,
      lng: expected!.lng,
    });
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves direct UTM coordinates and converts them to WGS84', async () => {
    const expected = parseCoordinateInput('33T 292332 4642055');
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: '33T 292332 4642055',
      }),
    });

    expect(result?.points[0].source).toBe('direct');
    expect(result?.points[0]).toMatchObject(expected!);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves embedded UTM coordinates from message text', async () => {
    const expected = parseCoordinateInput('33T 292332 4642055');
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'ROME\n33T 292332 4642055',
      }),
    });

    expect(result?.points[0].source).toBe('direct');
    expect(result?.points[0]).toMatchObject(expected!);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves embedded UTM coordinates after a label prefix', async () => {
    const expected = parseCoordinateInput('33T 292332 4642055');
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'Coordinates: 33T 292332 4642055',
      }),
    });

    expect(result?.points[0].source).toBe('direct');
    expect(result?.points[0]).toMatchObject(expected!);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('does not resolve UTM embedded inside an alphanumeric token', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'A33T 292332 4642055B',
      }),
    });

    expect(result).toBeNull();
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('does not resolve malformed embedded UTM coordinates', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: '33T 29233 4642055',
      }),
    });

    expect(result).toBeNull();
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('does not resolve invalid DMS coordinates', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: "50°61'13 30°31'24",
      }),
    });

    expect(result).toBeNull();
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('does not resolve DMS coordinates with seconds >= 60', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: "50°27'60 30°31'24",
      }),
    });

    expect(result).toBeNull();
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('does not resolve DMS coordinates with latitude degrees above 90', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: "91°00'00 30°31'24",
      }),
    });

    expect(result).toBeNull();
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('does not resolve DMS coordinates with longitude degrees above 180', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: "50°27'13 181°00'00",
      }),
    });

    expect(result).toBeNull();
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('keeps embedded UTM coordinates ahead of palitra tokens', async () => {
    const expected = parseCoordinateInput('33T 292332 4642055');
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'ROME\n33T 292332 4642055',
        textMarked: [{ CNPointC: { text: 'BRAVO', etalon: 'BRAVO' } } as ContentNode],
      }),
    });

    expect(result?.points[0].source).toBe('direct');
    expect(result?.points[0]).toMatchObject(expected!);
    expect(result?.etalons).toEqual([]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('uses direct coordinates from text exclusively when text and coords both contain points', async () => {
    const textPoints = [
      { x: 5268241, y: 6676046 },
      { x: 5268389, y: 6676122 },
      { x: 5268455, y: 6676062 },
    ] as const;
    const expectedPoints = textPoints.map((point) => {
      const converted = convertCoordinateToWgs84({
        kind: 'usk2000',
        x: point.x,
        y: point.y,
      } satisfies ImporterCoordinate);
      expect(converted).not.toBeNull();
      return converted!;
    });

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        coords: '50.45044, 30.52355',
        text: textPoints.map((point) => `X=${point.x} Y=${point.y}`).join('\n'),
      }),
    });

    expect(result?.lookupError).toBeNull();
    expect(result?.etalons).toEqual([]);
    expect(result?.points).toHaveLength(3);
    expect(result?.points.map((point) => [point.lat, point.lng])).toEqual(
      expectedPoints.map((point) => [point.lat, point.lng]),
    );
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('uses direct coordinates from text even when coords contains a different valid point', async () => {
    const expected = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5268241,
      y: 6676046,
    } satisfies ImporterCoordinate);
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        coords: '49.12345, 31.54321',
        text: 'X=5268241 Y=6676046',
      }),
    });

    expect(result?.lookupError).toBeNull();
    expect(result?.etalons).toEqual([]);
    expect(result?.points).toEqual([
      {
        source: 'direct',
        lat: expected!.lat,
        lng: expected!.lng,
        label: `${renderWgsFloat(expected!.lat)}, ${renderWgsFloat(expected!.lng)}`,
      },
    ]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves embedded UTM coordinates after the eligibility guard has cached a miss', async () => {
    const message = createMessage({
      text: 'ROME\n33T 292332 4642055',
    });

    expect(hasCoordinatePreviewCandidate(message, palitraTagsMap)).toBe(true);
    expect(
      await resolveMessageCoordinatePreview({ message, tagsMap: palitraTagsMap }),
    ).toMatchObject({
      points: [expect.objectContaining({ source: 'direct' })],
      lookupError: null,
    });
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('does not resolve point tokens when the message has no Palitra tag', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'routine',
        pointTokens: [{ etalon: 'BRAVO' }],
      }),
    });

    expect(result).toBeNull();
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves multiple palitra tokens in order and omits genuine misses', async () => {
    vi.mocked(listMapPalitrasV2).mockResolvedValue([createPalitra(7)] as never);
    vi.mocked(searchPalitraPoints)
      .mockResolvedValueOnce([
        {
          points: [
            {
              label: 'ALPHA',
              coords: { lat: 50.11, lng: 30.11 },
            },
          ],
        },
      ] as never)
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        {
          points: [
            {
              label: 'CHARLIE',
              coords: { lat: 50.33, lng: 30.33 },
            },
          ],
        },
      ] as never);

    const result = await resolveMessageCoordinatePreview({
      tagsMap: palitraTagsMap,
      message: createMessage({
        text: 'routine',
        inboxTags: [{ tagId: 7 }],
        pointTokens: [{ etalon: 'ALPHA' }, { etalon: 'BRAVO' }, { etalon: 'CHARLIE' }],
      }),
    });

    expect(result).toEqual({
      points: [
        {
          source: 'palitra',
          lat: 50.11,
          lng: 30.11,
          label: 'ALPHA',
        },
        {
          source: 'palitra',
          lat: 50.33,
          lng: 30.33,
          label: 'CHARLIE',
        },
      ],
      etalons: ['ALPHA', 'BRAVO', 'CHARLIE'],
      lookupError: null,
    });
    expect(listMapPalitrasV2).toHaveBeenCalledTimes(1);
    expect(searchPalitraPoints).toHaveBeenCalledTimes(3);
  });

  it('retains successful palitra points when a later lookup fails', async () => {
    vi.mocked(listMapPalitrasV2).mockResolvedValue([createPalitra(7)] as never);
    vi.mocked(searchPalitraPoints)
      .mockResolvedValueOnce([
        {
          points: [
            {
              label: 'ALPHA',
              coords: { lat: 50.11, lng: 30.11 },
            },
          ],
        },
      ] as never)
      .mockRejectedValueOnce(new Error('point search failed'));

    const result = await resolveMessageCoordinatePreview({
      tagsMap: palitraTagsMap,
      message: createMessage({
        text: 'routine',
        inboxTags: [{ tagId: 7 }],
        pointTokens: [{ etalon: 'ALPHA' }, { etalon: 'BRAVO' }],
      }),
    });

    expect(result?.points).toEqual([
      {
        source: 'palitra',
        lat: 50.11,
        lng: 30.11,
        label: 'ALPHA',
      },
    ]);
    expect(result?.lookupError).toMatchObject({
      name: 'CoordinatePreviewLookupError',
      kind: 'point-search',
    });
    expect(listMapPalitrasV2).toHaveBeenCalledTimes(1);
    expect(searchPalitraPoints).toHaveBeenCalledTimes(2);
  });

  it('falls back to palitra lookup when direct parsing fails', async () => {
    vi.mocked(listMapPalitrasV2).mockResolvedValue([createPalitra(7)] as never);
    vi.mocked(searchPalitraPoints).mockResolvedValue([
      {
        points: [
          {
            label: 'BRAVO',
            coords: { lat: 50.45, lng: 30.52 },
          },
        ],
      },
    ] as never);

    const result = await resolveMessageCoordinatePreview({
      tagsMap: palitraTagsMap,
      message: createMessage({
        text: 'invalid direct text',
        coords: 'X=12\nY=abc',
        inboxTags: [{ tagId: 7 }],
        textMarked: [{ CNPointC: { text: 'BRAVO', etalon: 'BRAVO' } } as ContentNode],
      }),
    });

    expect(result).toEqual({
      points: [
        {
          source: 'palitra',
          lat: 50.45,
          lng: 30.52,
          label: 'BRAVO',
        },
      ],
      etalons: ['BRAVO'],
      lookupError: null,
    });
    expect(listMapPalitrasV2).toHaveBeenCalledTimes(1);
    expect(searchPalitraPoints).toHaveBeenCalledTimes(1);
  });

  it('keeps the first valid direct coordinate when both direct and palitra data are present', async () => {
    const result = await resolveMessageCoordinatePreview({
      tagsMap: palitraTagsMap,
      message: createMessage({
        coords: '50.45044, 30.52355',
        textMarked: [{ CNPointC: { text: 'BRAVO', etalon: 'BRAVO' } } as ContentNode],
      }),
    });

    expect(result?.points[0].source).toBe('direct');
    expect(result?.etalons).toEqual([]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('returns null for unknown palitra labels when no direct coordinates are valid', async () => {
    vi.mocked(listMapPalitrasV2).mockResolvedValue([createPalitra(7)] as never);
    vi.mocked(searchPalitraPoints).mockResolvedValue([] as never);

    const result = await resolveMessageCoordinatePreview({
      tagsMap: palitraTagsMap,
      message: createMessage({
        text: 'unknown palitra label',
        inboxTags: [{ tagId: 7 }],
        textMarked: [{ CNPointC: { text: 'UNKNOWN', etalon: 'UNKNOWN' } } as ContentNode],
      }),
    });

    expect(result).toBeNull();
    expect(listMapPalitrasV2).toHaveBeenCalledTimes(1);
    expect(searchPalitraPoints).toHaveBeenCalledTimes(1);
  });

  it('retries palette loading after a failed request and then resolves a palitra preview', async () => {
    vi.mocked(listMapPalitrasV2)
      .mockRejectedValueOnce(new Error('palette list failed'))
      .mockResolvedValueOnce([createPalitra(7)] as never);
    vi.mocked(searchPalitraPoints).mockResolvedValue([
      {
        points: [
          {
            label: 'BRAVO',
            coords: { lat: 50.45, lng: 30.52 },
          },
        ],
      },
    ] as never);

    const message = createMessage({
      text: 'routine',
      inboxTags: [{ tagId: 7 }],
      pointTokens: [{ etalon: 'BRAVO' }],
    });

    expect(
      await resolveMessageCoordinatePreview({ message, tagsMap: palitraTagsMap }),
    ).toMatchObject({
      points: [],
      etalons: ['BRAVO'],
      lookupError: {
        name: 'CoordinatePreviewLookupError',
        kind: 'palette-list',
      },
    });
    expect(
      await resolveMessageCoordinatePreview({ message, tagsMap: palitraTagsMap }),
    ).toMatchObject({
      points: [
        {
          source: 'palitra',
          lat: 50.45,
          lng: 30.52,
          label: 'BRAVO',
        },
      ],
      etalons: ['BRAVO'],
      lookupError: null,
    });
    expect(listMapPalitrasV2).toHaveBeenCalledTimes(2);
    expect(searchPalitraPoints).toHaveBeenCalledTimes(1);
  });

  it('retries point search after a failed request and then resolves a palitra preview', async () => {
    vi.mocked(listMapPalitrasV2).mockResolvedValue([createPalitra(7)] as never);
    vi.mocked(searchPalitraPoints)
      .mockRejectedValueOnce(new Error('point search failed'))
      .mockResolvedValueOnce([
        {
          points: [
            {
              label: 'BRAVO',
              coords: { lat: 50.45, lng: 30.52 },
            },
          ],
        },
      ] as never);

    const message = createMessage({
      text: 'routine',
      inboxTags: [{ tagId: 7 }],
      pointTokens: [{ etalon: 'BRAVO' }],
    });

    expect(
      await resolveMessageCoordinatePreview({ message, tagsMap: palitraTagsMap }),
    ).toMatchObject({
      points: [],
      etalons: ['BRAVO'],
      lookupError: {
        name: 'CoordinatePreviewLookupError',
        kind: 'point-search',
      },
    });
    expect(
      await resolveMessageCoordinatePreview({ message, tagsMap: palitraTagsMap }),
    ).toMatchObject({
      points: [
        {
          source: 'palitra',
          lat: 50.45,
          lng: 30.52,
          label: 'BRAVO',
        },
      ],
      etalons: ['BRAVO'],
      lookupError: null,
    });
    expect(listMapPalitrasV2).toHaveBeenCalledTimes(1);
    expect(searchPalitraPoints).toHaveBeenCalledTimes(2);
  });

  it('keeps a genuine empty palette list cached', async () => {
    vi.mocked(listMapPalitrasV2).mockResolvedValue([] as never);

    const message = createMessage({
      text: 'routine',
      inboxTags: [{ tagId: 7 }],
      pointTokens: [{ etalon: 'BRAVO' }],
    });

    expect(await resolveMessageCoordinatePreview({ message, tagsMap: palitraTagsMap })).toBeNull();
    expect(await resolveMessageCoordinatePreview({ message, tagsMap: palitraTagsMap })).toBeNull();
    expect(listMapPalitrasV2).toHaveBeenCalledTimes(1);
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('keeps a genuine point miss cached', async () => {
    vi.mocked(listMapPalitrasV2).mockResolvedValue([createPalitra(7)] as never);
    vi.mocked(searchPalitraPoints).mockResolvedValue([] as never);

    const message = createMessage({
      text: 'routine',
      inboxTags: [{ tagId: 7 }],
      pointTokens: [{ etalon: 'BRAVO' }],
    });

    expect(await resolveMessageCoordinatePreview({ message, tagsMap: palitraTagsMap })).toBeNull();
    expect(await resolveMessageCoordinatePreview({ message, tagsMap: palitraTagsMap })).toBeNull();
    expect(listMapPalitrasV2).toHaveBeenCalledTimes(1);
    expect(searchPalitraPoints).toHaveBeenCalledTimes(1);
  });
});

describe('hasCoordinatePreviewCandidate', () => {
  it.each([
    {
      label: 'ordinary text',
      message: createMessage({ text: 'Routine message with no coordinates' }),
      expected: false,
    },
    {
      label: 'frequency-like text',
      message: createMessage({ text: 'Freq 123.45 callsign ALPHA' }),
      expected: false,
    },
    {
      label: 'filename-like text',
      message: createMessage({ text: 'report_2026_07_14.txt' }),
      expected: false,
    },
    {
      label: 'standalone numbers',
      message: createMessage({ text: '123 456 789' }),
      expected: false,
    },
    {
      label: 'WGS84 text',
      message: createMessage({ text: '50.45044, 30.52355' }),
      expected: true,
    },
    {
      label: 'MGRS text',
      message: createMessage({ text: '36U YA 00000 00000' }),
      expected: true,
    },
    {
      label: 'UTM text',
      message: createMessage({ text: '33T 292332 4642055' }),
      expected: true,
    },
    {
      label: 'embedded UTM text',
      message: createMessage({ text: 'ROME\n33T 292332 4642055' }),
      expected: true,
    },
    {
      label: 'prefixed UTM text',
      message: createMessage({ text: 'Coordinates: 33T 292332 4642055' }),
      expected: true,
    },
    {
      label: 'UTM in alphanumeric token',
      message: createMessage({ text: 'A33T 292332 4642055B' }),
      expected: false,
    },
    {
      label: 'malformed embedded UTM',
      message: createMessage({ text: '33T 29233 4642055' }),
      expected: false,
    },
    {
      label: 'USK-2000 text',
      message: createMessage({ text: 'X=5012345\nY=5034567' }),
      expected: true,
    },
    {
      label: 'DMS text',
      message: createMessage({ text: "50°27'13 30°31'24" }),
      expected: true,
    },
    {
      label: 'invalid DMS text',
      message: createMessage({ text: "50°61'13 30°31'24" }),
      expected: false,
    },
    {
      label: 'seconds >= 60',
      message: createMessage({ text: "50°27'60 30°31'24" }),
      expected: false,
    },
    {
      label: 'latitude degrees above 90',
      message: createMessage({ text: "91°00'00 30°31'24" }),
      expected: false,
    },
    {
      label: 'longitude degrees above 180',
      message: createMessage({ text: "50°27'13 181°00'00" }),
      expected: false,
    },
    {
      label: 'Palitra token without tag',
      message: createMessage({
        text: 'routine',
        pointTokens: [{ etalon: 'BRAVO' }],
      }),
      expected: false,
    },
    {
      label: 'Palitra token with tag',
      message: createMessage({
        text: 'routine',
        pointTokens: [{ etalon: 'BRAVO' }],
        textMarked: [{ CNPointC: { text: 'BRAVO', etalon: 'BRAVO' } } as ContentNode],
        inboxTags: [{ tagId: 7 }],
      }),
      expected: true,
    },
    {
      label: 'non-empty coords without a direct parse',
      message: createMessage({ coords: 'not empty' }),
      expected: false,
    },
    {
      label: 'malformed X/Y without Palitra token',
      message: createMessage({ text: 'X=12\nY=abc' }),
      expected: false,
    },
    {
      label: 'malformed X/Y with Palitra token',
      message: createMessage({
        text: 'X=12\nY=abc',
        inboxTags: [{ tagId: 7 }],
        textMarked: [{ CNPointC: { text: 'BRAVO', etalon: 'BRAVO' } } as ContentNode],
      }),
      expected: true,
    },
  ])('$label -> $expected', ({ message, expected }) => {
    expect(hasCoordinatePreviewCandidate(message, palitraTagsMap)).toBe(expected);
  });
});
