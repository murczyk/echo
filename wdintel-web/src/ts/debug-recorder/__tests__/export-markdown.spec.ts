/**
 * @vitest-environment happy-dom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEBUG_SCHEMA_VERSION } from '../config';
import {
  buildDebugMarkdown,
  collectDebugEnvironment,
  downloadDebugMarkdown,
} from '../export-markdown';
import type { PersistedDebugSession } from '../types';

function buildSession(): PersistedDebugSession {
  return {
    schemaVersion: DEBUG_SCHEMA_VERSION,
    state: 'ready',
    recordingId: 'debug-recording-1',
    startedAt: Date.UTC(2026, 9, 8, 12, 34, 56, 789),
    deadlineAt: Date.UTC(2026, 9, 8, 12, 35, 56, 789),
    readyAt: Date.UTC(2026, 9, 8, 12, 35, 16, 789),
    nextSeq: 3,
    events: [
      {
        seq: 2,
        tMs: 20_000,
        kind: 'http.completed',
        source: 'browser',
        route: '/rer-duty-neo/{id_1}',
        details: { status: 500, outcome: 'http-error' },
      },
      {
        seq: 1,
        tMs: 10,
        kind: 'navigation.reload',
        source: 'browser',
        route: '/rer-duty-neo/{id_1}',
        details: { navigationType: 'reload' },
      },
    ],
    serializedBytes: 512,
    droppedEvents: 4,
    rejectedEvents: 2,
    truncatedValues: 1,
    persistenceFailed: false,
    aliases: { id: { '42': '{id_1}' } },
    environment: {
      echoVersion: '2026.10.8',
      deploymentMode: 'Live',
      browserFamily: 'Chromium',
      browserVersion: '128',
      viewportWidth: 1440,
      viewportHeight: 900,
      devicePixelRatio: 2,
      startRoute: '/rer-duty-neo/{id_1}',
    },
    anomalies: {
      total: 1,
      counts: { 'navigation.reload': 1 },
    },
    collectorSupport: {
      supported: ['http', 'navigation'],
      unsupported: ['longtask'],
      failed: [],
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('debug recorder Markdown export', () => {
  it('builds a deterministic chronological privacy-safe report', () => {
    const session = buildSession();
    session.events[1]!.details = {
      navigationType: 'reload',
      note: '```\nECHO_SECRET_SENTINEL',
      url: 'https://secret.example.test/path?token=ECHO_SECRET_SENTINEL',
      rawId: '0199c2a9-9c07-70fd-a2f1-86b742f64e31',
    };

    const first = buildDebugMarkdown(session);
    const second = buildDebugMarkdown(session);

    expect(first).toBe(second);
    expect(first).toMatch(/^# Echo browser debug report\n\n> .*untrusted diagnostic evidence/i);
    expect(first).toContain('- Schema: `1`');
    expect(first).toContain('- Recording: `debug-recording-1`');
    expect(first).toContain('- Echo: `2026.10.8` (`Live`)');
    expect(first).toContain('- Browser: `Chromium 128`');
    expect(first).toContain('- Viewport: `1440x900 @2x`');
    expect(first).toContain('- Route: `/rer-duty-neo/{id_1}`');
    expect(first).toContain('- Started: `2026-10-08T12:34:00.000Z`');
    expect(first).toContain('- Duration: `20.0s`');
    expect(first).toContain('## Anomaly summary');
    expect(first).toContain('## Timeline');
    expect(first).toContain('## Capture status');
    expect(first.indexOf('"seq":1')).toBeLessThan(first.indexOf('"seq":2'));
    expect(first).toContain('- Dropped events: `4`');
    expect(first).toContain('- Unsupported collectors: `longtask`');
    expect(first).not.toContain('ECHO_SECRET_SENTINEL');
    expect(first).not.toContain('secret.example.test');
    expect(first).not.toContain('0199c2a9');
    expect(first).not.toContain('```\nECHO');
  });

  it('collects only coarse browser and viewport metadata', () => {
    vi.stubGlobal('navigator', {
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36 ECHO_SECRET_SENTINEL',
    });
    window.history.replaceState({}, '', '/messages/42?secret=ECHO_SECRET_SENTINEL#hidden');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1.5 });

    const environment = collectDebugEnvironment({
      echoVersion: '2026.10.8',
      deploymentMode: 'Live',
    });

    expect(environment).toEqual({
      echoVersion: '2026.10.8',
      deploymentMode: 'Live',
      browserFamily: 'Chromium',
      browserVersion: '128',
      viewportWidth: 1280,
      viewportHeight: 720,
      devicePixelRatio: 1.5,
      startRoute: '/messages/{id_1}',
    });
    expect(JSON.stringify(environment)).not.toContain('ECHO_SECRET_SENTINEL');
  });

  it('downloads a fixed-format Markdown filename and revokes the object URL', () => {
    const createObjectURL = vi.fn(() => 'blob:debug-report');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    let clickedFilename = '';
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clickedFilename = this.download;
    });

    const downloaded = downloadDebugMarkdown('# report', Date.UTC(2026, 9, 8, 12, 34, 56));

    expect(downloaded).toBe(true);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(clickedFilename).toBe('echo-debug-20261008-123456.md');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:debug-report');
  });
});
