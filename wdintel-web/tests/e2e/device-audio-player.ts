import { expect, type Locator, type Page } from '@playwright/test';
import type { CustomAudioPlayer } from '@echoua/echo-audio-player';
import { wavBytes } from './device-audio-backend';
import { createServer, request, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export async function interruptedMediaProxy(
  origin: string,
  contentPath: string,
  prefixLength: number,
) {
  let fault: 'stall' | 'broken' | null = 'stall';
  const streams = new Set<ServerResponse>();
  const server = createServer((req, response) => {
    const upstream = request(
      new URL(req.url!, origin),
      { method: req.method, headers: { ...req.headers, host: new URL(origin).host } },
      (incoming) => {
        const start = Number(req.headers.range?.match(/^bytes=(\d+)-/)?.[1] ?? 0);
        if (
          fault === 'broken' &&
          req.method === 'GET' &&
          req.url === contentPath &&
          incoming.statusCode! < 300
        ) {
          incoming.resume();
          response.writeHead(503, { 'Cache-Control': 'no-store' });
          response.end();
          return;
        }
        const interrupt =
          fault &&
          req.method === 'GET' &&
          req.url === contentPath &&
          start === 0 &&
          incoming.statusCode! < 300;
        response.writeHead(incoming.statusCode!, incoming.headers);
        if (!interrupt) {
          incoming.pipe(response);
          return;
        }
        streams.add(response);
        response.on('close', () => streams.delete(response));
        let sent = 0;
        incoming.on('data', (bytes: Buffer) => {
          const end = Math.min(bytes.length, prefixLength - sent);
          if (end > 0) {
            response.write(bytes.subarray(0, end));
            sent += end;
          }
        });
        incoming.on('error', () => response.destroy());
      },
    );
    upstream.on('error', () => response.destroy());
    req.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    interrupt: () => {
      fault = 'broken';
      for (const response of streams) response.destroy();
    },
    recover: () => {
      fault = null;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function toneWav(seconds: number) {
  const bytes = wavBytes(seconds);
  for (let index = 0; index < seconds * 8000; index++) {
    const frequency = index < seconds * 4000 ? 440 : 880;
    bytes.writeInt16LE(
      Math.round(9000 * Math.sin((index * frequency * Math.PI * 2) / 8000)),
      44 + index * 2,
    );
  }
  return bytes;
}

const rowClicks = new WeakMap<Page, Map<string, number>>();
const filterClicks = new WeakMap<Page, number>();

export async function toggleAudioFilter(page: Page) {
  const remaining = 400 - (Date.now() - (filterClicks.get(page) ?? 0));
  if (remaining > 0) await page.waitForTimeout(remaining);
  await page.getByRole('button', { name: /^Фільтри аудіо/ }).click();
  filterClicks.set(page, Date.now());
  await page.getByRole('menuitemcheckbox', { name: 'Тільки необроблені' }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}

export async function expectAudioFilter(page: Page, checked: boolean) {
  await expect(page.getByRole('button', { name: /^Фільтри аудіо/ })).toHaveAttribute(
    'aria-label',
    checked ? 'Фільтри аудіо: тільки необроблені' : 'Фільтри аудіо',
  );
}

export async function selectAudio(page: Page, id: string) {
  const back = page.getByRole('button', { name: 'До аудіо', exact: true });
  if (await back.isVisible()) await back.click();
  const clicks = rowClicks.get(page) ?? new Map<string, number>();
  rowClicks.set(page, clicks);
  // PowerButton ignores repeated clicks on the same button for 400 ms.
  const remaining = 400 - (Date.now() - (clicks.get(id) ?? 0));
  if (remaining > 0) await page.waitForTimeout(remaining);
  const row = page.locator(`[data-audio-id="${id}"]`);
  await row.click();
  clicks.set(id, Date.now());
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  const player = page.locator(
    `[data-device-audio-player] custom-audio-player[src$="/${id}/content"]`,
  );
  await expect(player).toHaveCount(1);
  await expect
    .poll(() =>
      player.evaluate(
        (element: CustomAudioPlayer, audioId: string) =>
          element.audio.getAttribute('src')?.endsWith(`/${audioId}/content`),
        id,
      ),
    )
    .toBe(true);
  return player;
}

export async function ready(player: Locator) {
  await expect
    .poll(() => player.evaluate((element: CustomAudioPlayer) => element.audio.readyState))
    .toBeGreaterThanOrEqual(2);
}

export async function playing(player: Locator) {
  await expect
    .poll(() =>
      player.evaluate(
        (element: CustomAudioPlayer) => !element.audio.paused && element.audio.currentTime > 0,
      ),
    )
    .toBe(true);
}

export function nativeState(player: Locator) {
  return player.evaluate((element: CustomAudioPlayer) => ({
    paused: element.audio.paused,
    time: element.audio.currentTime,
    duration: element.audio.duration,
    error: element.audio.error?.code ?? null,
    source: element.audio.getAttribute('src'),
    autoplay: element.autoplay,
  }));
}

export async function audible(player: Locator) {
  await expect
    .poll(() =>
      player.evaluate((element: CustomAudioPlayer) => {
        if (!element.audioContext || !element.gainNode) return 0;
        const analyser = element.audioContext.createAnalyser();
        analyser.fftSize = 1024;
        element.gainNode.connect(analyser);
        return new Promise<number>((resolve) =>
          setTimeout(() => {
            const data = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(data);
            element.gainNode?.disconnect(analyser);
            resolve(Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length));
          }, 100),
        );
      }),
    )
    .toBeGreaterThan(0.01);
}

export async function remember(player: Locator) {
  return player.evaluateHandle((element: CustomAudioPlayer) => element);
}
