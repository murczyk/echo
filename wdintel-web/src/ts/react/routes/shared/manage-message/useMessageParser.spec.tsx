// @vitest-environment happy-dom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DirectSubmitParseResponse } from '../../../services/api/direct-submit';
import { EMPTY_FORM_VALUES, type MessageFormData } from './manage-message-drawer.schema';
import { useMessageParser } from './useMessageParser';

const apiMocks = vi.hoisted(() => ({
  parseDirectSubmit: vi.fn(),
}));

vi.mock('../../../services/api/direct-submit', () => ({
  parseDirectSubmit: apiMocks.parseDirectSubmit,
}));

type ParserResult = ReturnType<typeof useMessageParser>;
type HarnessValue = { methods: UseFormReturn<MessageFormData>; parser: ParserResult };

function response(overrides: Partial<DirectSubmitParseResponse> = {}): DirectSubmitParseResponse {
  return {
    text: '',
    coords: [],
    to: [],
    locations: [],
    ...overrides,
  };
}

function Harness({
  onValue,
  setErrorMsg,
  autoParseEnabled = false,
}: {
  onValue: (value: HarnessValue) => void;
  setErrorMsg: (message: string | null) => void;
  autoParseEnabled?: boolean;
}) {
  const methods = useForm<MessageFormData>({ defaultValues: EMPTY_FORM_VALUES });
  const parser = useMessageParser(methods, false, setErrorMsg, {
    active: true,
    autoParseEnabled,
  });

  useEffect(() => onValue({ methods, parser }), [methods, onValue, parser]);
  return null;
}

describe('useMessageParser ownership', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: HarnessValue;
  let setErrorMsg: ReturnType<typeof vi.fn>;

  const mount = async (autoParseEnabled = false) => {
    await act(async () => {
      root.render(
        <Harness
          autoParseEnabled={autoParseEnabled}
          setErrorMsg={setErrorMsg}
          onValue={(value) => {
            latest = value;
          }}
        />,
      );
      await Promise.resolve();
    });
  };

  const setSource = async (value: string) => {
    await act(async () => {
      latest.methods.setValue('full_body', value);
      await Promise.resolve();
    });
  };

  const parse = async () => {
    await act(async () => {
      await latest.parser.handleParse();
    });
  };

  beforeEach(() => {
    apiMocks.parseDirectSubmit.mockReset();
    setErrorMsg = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('does not overwrite a manually corrected parsed field on a later parse', async () => {
    apiMocks.parseDirectSubmit
      .mockResolvedValueOnce(response({ freq: '149.500' }))
      .mockResolvedValueOnce(response({ freq: '151.000' }));
    await mount();
    await setSource('перша версія');
    await parse();
    expect(latest.methods.getValues('freq')).toBe('149.500');

    await act(async () => {
      latest.methods.setValue('freq', '150.000');
      await Promise.resolve();
    });
    await setSource('друга версія');
    await parse();

    expect(latest.methods.getValues('freq')).toBe('150.000');
    expect(latest.parser.parserFeedback?.conflictFields).toContain('freq');
  });

  it('does not refill a manually cleared time until explicitly accepted', async () => {
    apiMocks.parseDirectSubmit
      .mockResolvedValueOnce(response({ timestamp: '2026-09-22T12:30:00Z' }))
      .mockResolvedValueOnce(response({ timestamp: '2026-09-22T13:45:00Z' }));
    await mount();
    await setSource('час 12:30');
    await parse();
    expect(latest.methods.getValues('time')?.format('HH:mm')).toBe('12:30');

    await act(async () => {
      latest.methods.setValue('time', null);
      await Promise.resolve();
    });
    await setSource('час 13:45');
    await parse();
    expect(latest.methods.getValues('time')).toBeNull();

    await act(async () => {
      latest.parser.acceptParsedField('time');
      await Promise.resolve();
    });
    expect(latest.methods.getValues('time')?.format('HH:mm')).toBe('13:45');
  });

  it('keeps other conflicts visible after accepting one parsed field', async () => {
    apiMocks.parseDirectSubmit.mockResolvedValueOnce(
      response({ freq: '151.000', post: 'Розпізнаний пост' }),
    );
    await mount();
    await act(async () => {
      latest.methods.setValue('freq', '150.000');
      latest.methods.setValue('post', 'Ручний пост');
      await Promise.resolve();
    });
    await setSource('частота 151.000, розпізнаний пост');
    await parse();
    expect(latest.parser.parserFeedback?.conflictFields).toEqual(['freq', 'post']);

    await act(async () => {
      latest.parser.acceptParsedField('freq');
      await Promise.resolve();
    });

    expect(latest.methods.getValues('freq')).toBe('151.000');
    expect(latest.methods.getValues('post')).toBe('Ручний пост');
    expect(latest.parser.parserFeedback?.conflictFields).toEqual(['post']);
  });

  it('does not mistake guarded parser writes for manual changes', async () => {
    apiMocks.parseDirectSubmit
      .mockResolvedValueOnce(response({ freq: '149.500' }))
      .mockResolvedValueOnce(response({ freq: '151.000' }));
    await mount();
    await setSource('перша версія');
    await parse();
    await setSource('друга версія');
    await parse();

    expect(latest.methods.getValues('freq')).toBe('151.000');
    expect(latest.parser.parserFeedback?.conflictFields).not.toContain('freq');
  });

  it('clears only parser-owned values when source becomes empty', async () => {
    apiMocks.parseDirectSubmit.mockResolvedValueOnce(response({ freq: '149.500' }));
    await mount();
    await act(async () => {
      latest.methods.setValue('unit', 'Початковий підрозділ');
      await Promise.resolve();
    });
    await setSource('частота 149.500');
    await parse();
    await act(async () => {
      latest.methods.setValue('time', null);
      await Promise.resolve();
    });

    await setSource('');

    expect(latest.methods.getValues('freq')).toBe('');
    expect(latest.methods.getValues('unit')).toBe('Початковий підрозділ');
    expect(latest.methods.getValues('time')).toBeNull();
    expect(apiMocks.parseDirectSubmit).toHaveBeenCalledOnce();
  });

  it('silently ignores a manual parse request with empty source', async () => {
    await mount();
    await parse();

    expect(apiMocks.parseDirectSubmit).not.toHaveBeenCalled();
    expect(setErrorMsg).not.toHaveBeenCalled();
  });

  it('auto-parses after 700 ms and restarts the timer after another edit', async () => {
    vi.useFakeTimers();
    apiMocks.parseDirectSubmit.mockResolvedValue(response({ freq: '149.500' }));
    await mount(true);
    await setSource('перша');

    await act(async () => {
      vi.advanceTimersByTime(699);
    });
    expect(apiMocks.parseDirectSubmit).not.toHaveBeenCalled();

    await setSource('друга');
    await act(async () => {
      vi.advanceTimersByTime(699);
    });
    expect(apiMocks.parseDirectSubmit).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await Promise.resolve();
    });
    expect(apiMocks.parseDirectSubmit).toHaveBeenCalledOnce();
    expect(apiMocks.parseDirectSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ full_body: 'друга' }),
    );
  });

  it('ignores an older response after the source changes and returns to the same text', async () => {
    let resolveFirst!: (value: DirectSubmitParseResponse) => void;
    apiMocks.parseDirectSubmit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    await mount();
    await setSource('однаковий текст');

    let pending!: Promise<void>;
    await act(async () => {
      pending = latest.parser.handleParse();
      await Promise.resolve();
    });
    await setSource('тимчасова зміна');
    await setSource('однаковий текст');
    await act(async () => {
      resolveFirst(response({ freq: '149.500' }));
      await pending;
    });

    expect(latest.methods.getValues('freq')).toBe('');
  });

  it('invalidates an in-flight response when the parser session resets', async () => {
    let resolveParse!: (value: DirectSubmitParseResponse) => void;
    apiMocks.parseDirectSubmit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveParse = resolve;
        }),
    );
    await mount();
    await setSource('повідомлення');

    let pending!: Promise<void>;
    await act(async () => {
      pending = latest.parser.handleParse();
      await Promise.resolve();
    });
    await act(async () => {
      latest.parser.resetParserSession();
      resolveParse(response({ freq: '149.500' }));
      await pending;
    });

    expect(latest.methods.getValues('freq')).toBe('');
    expect(latest.parser.parseStatus).toBe('idle');
  });

  it('preserves all values when parsing fails', async () => {
    apiMocks.parseDirectSubmit.mockRejectedValueOnce(new Error('Parse failure'));
    await mount();
    await act(async () => {
      latest.methods.setValue('freq', '150.000');
      await Promise.resolve();
    });
    await setSource('помилкове повідомлення');
    await parse();

    expect(latest.methods.getValues('freq')).toBe('150.000');
    expect(latest.parser.parseStatus).toBe('error');
    expect(setErrorMsg).toHaveBeenCalledWith('Parse failure');
  });
});
