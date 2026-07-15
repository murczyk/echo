/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContentNode, InboxMessage, PalitraReadV2 } from '../../../../../Bindings';
import {
  convertCoordinateToWgs84,
  extractCoordinates,
  renderWgsFloat,
  type ImporterCoordinate,
} from '../../importer-beta/coordinates';
import { listMapPalitrasV2, searchPalitraPoints } from '../../../services/api/palitra';
import { parseCoordinateInput } from '../../../../maps/coordinate-search';
import {
  primeCoordinatePreviewPalitraIds,
  resetCoordinatePreviewStateForTests,
  hasCoordinatePreviewCandidate,
  resolveMessageCoordinatePreview,
} from './message-coordinate-preview';

vi.mock('../../../services/api/palitra', () => ({
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

describe('message coordinate preview resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCoordinatePreviewStateForTests();
  });

  it('resolves direct WGS84 coordinates from msg.coords without loading palitras', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({ coords: '50.45044, 30.52355' }),
    });

    expect(result).toEqual({
      source: 'direct',
      point: {
        lat: 50.45044,
        lng: 30.52355,
        label: '50.45044, 30.52355',
      },
      etalons: [],
      pointCount: 1,
    });
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves direct WGS84 coordinates from message text before palitra lookup', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({ text: '50.45044, 30.52355' }),
    });

    expect(result?.source).toBe('direct');
    expect(result?.point.label).toBe('50.45044, 30.52355');
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves direct USK-2000 coordinates and converts them to WGS84', async () => {
    const expected = convertCoordinateToWgs84({
      kind: 'usk2000',
      x: 5012345,
      y: 5034567,
    } satisfies ImporterCoordinate);
    expect(expected).not.toBeNull();

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'X=5012345\nY=5034567',
      }),
    });

    expect(result?.source).toBe('direct');
    expect(result?.point.label).toBe(
      `${renderWgsFloat(expected!.lat)}, ${renderWgsFloat(expected!.lng)}`,
    );
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

    expect(result?.source).toBe('direct');
    expect(result?.point).toMatchObject({
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

    expect(result?.source).toBe('direct');
    expect(result?.point).toMatchObject({
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

    expect(result?.source).toBe('direct');
    expect(result?.point).toMatchObject(expected!);
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

    expect(result?.source).toBe('direct');
    expect(result?.point).toMatchObject(expected!);
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

    expect(result?.source).toBe('direct');
    expect(result?.point).toMatchObject(expected!);
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

    expect(result?.source).toBe('direct');
    expect(result?.point).toMatchObject(expected!);
    expect(result?.etalons).toEqual([]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('resolves embedded UTM coordinates after the eligibility guard has cached a miss', async () => {
    const message = createMessage({
      text: 'ROME\n33T 292332 4642055',
    });

    expect(hasCoordinatePreviewCandidate(message)).toBe(true);
    expect(await resolveMessageCoordinatePreview({ message })).toMatchObject({
      source: 'direct',
    });
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
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
      message: createMessage({
        coords: 'X=12\nY=abc',
        textMarked: [{ CNPointC: { text: 'BRAVO', etalon: 'BRAVO' } } as ContentNode],
      }),
    });

    expect(result).toEqual({
      source: 'palitra',
      point: {
        lat: 50.45,
        lng: 30.52,
        label: 'BRAVO',
      },
      etalons: ['BRAVO'],
      pointCount: 1,
    });
    expect(listMapPalitrasV2).toHaveBeenCalledTimes(1);
    expect(searchPalitraPoints).toHaveBeenCalledTimes(1);
  });

  it('keeps the first valid direct coordinate when both direct and palitra data are present', async () => {
    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        coords: '50.45044, 30.52355',
        textMarked: [{ CNPointC: { text: 'BRAVO', etalon: 'BRAVO' } } as ContentNode],
      }),
    });

    expect(result?.source).toBe('direct');
    expect(result?.etalons).toEqual([]);
    expect(listMapPalitrasV2).not.toHaveBeenCalled();
    expect(searchPalitraPoints).not.toHaveBeenCalled();
  });

  it('returns null for unknown palitra labels when no direct coordinates are valid', async () => {
    vi.mocked(listMapPalitrasV2).mockResolvedValue([createPalitra(7)] as never);
    vi.mocked(searchPalitraPoints).mockResolvedValue([] as never);

    const result = await resolveMessageCoordinatePreview({
      message: createMessage({
        text: 'unknown palitra label',
        textMarked: [{ CNPointC: { text: 'UNKNOWN', etalon: 'UNKNOWN' } } as ContentNode],
      }),
    });

    expect(result).toBeNull();
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
      label: 'Palitra token',
      message: createMessage({
        text: 'routine',
        pointTokens: [{ etalon: 'BRAVO' }],
      }),
      expected: true,
    },
    {
      label: 'marked Palitra token',
      message: createMessage({
        text: 'routine',
        textMarked: [{ CNPointC: { text: 'BRAVO', etalon: 'BRAVO' } } as ContentNode],
      }),
      expected: true,
    },
    {
      label: 'non-empty coords',
      message: createMessage({ coords: 'not empty' }),
      expected: true,
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
        textMarked: [{ CNPointC: { text: 'BRAVO', etalon: 'BRAVO' } } as ContentNode],
      }),
      expected: true,
    },
  ])('$label -> $expected', ({ message, expected }) => {
    expect(hasCoordinatePreviewCandidate(message)).toBe(expected);
  });
});
