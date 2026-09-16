import { expect, test, type Browser } from '@playwright/test';

import {
  installRouteLoadComparisonMocks,
  type RouteLoadSuite,
} from './page-loading-comparison.fixtures';

type RouteComparisonCase = {
  name: string;
  suite: RouteLoadSuite;
  classicPath: '/rer-duty' | '/rer-callsigns' | '/rer-palitra' | '/admin/messenger';
  neoPath: '/rer-duty-neo' | '/rer-callsigns-neo' | '/rer-palitra-neo' | '/admin/messenger-neo';
  classicMarker: string;
  neoMarker: string;
  markerKind: 'heading' | 'selector';
  maxDeltaMs: number;
};

type LoadResult = {
  markerMs: number;
};

// @test-scope safeguard: prevents Neo route first load from exceeding the equivalent classic route by more than the configured threshold.
test.describe('@perf', () => {
  async function measureRouteLoad(
    browser: Browser,
    path: RouteComparisonCase['classicPath'] | RouteComparisonCase['neoPath'],
    suite: RouteLoadSuite,
    marker: { kind: 'heading'; text: string } | { kind: 'selector'; text: string },
  ): Promise<LoadResult> {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await installRouteLoadComparisonMocks(page, suite, {
        delayMs: 1_500,
      });

      const startedAt = performance.now();
      await page.goto(path, { waitUntil: 'domcontentloaded' });

      if (marker.kind === 'heading') {
        await expect(page.getByRole('heading', { name: marker.text, level: 1 })).toBeVisible();
      } else {
        await expect(page.locator(marker.text).first()).toBeVisible();
      }

      return {
        markerMs: performance.now() - startedAt,
      };
    } finally {
      await context.close();
    }
  }

  const routeComparisons: RouteComparisonCase[] = [
    {
      name: 'rer-duty',
      suite: 'duty',
      classicPath: '/rer-duty',
      neoPath: '/rer-duty-neo',
      classicMarker: '.rer-duty',
      neoMarker: '.rer-duty',
      markerKind: 'selector',
      maxDeltaMs: 1_000,
    },
    {
      name: 'rer-callsigns',
      suite: 'callsigns',
      classicPath: '/rer-callsigns',
      neoPath: '/rer-callsigns-neo',
      classicMarker: 'позивні (стара)',
      neoMarker: 'Позивні',
      markerKind: 'heading',
      maxDeltaMs: 1_000,
    },
    {
      name: 'rer-palitra',
      suite: 'palitra',
      classicPath: '/rer-palitra',
      neoPath: '/rer-palitra-neo',
      classicMarker: 'палітри (стара)',
      neoMarker: 'Палітри',
      markerKind: 'heading',
      maxDeltaMs: 1_000,
    },
    {
      name: 'messenger',
      suite: 'messenger',
      classicPath: '/admin/messenger',
      neoPath: '/admin/messenger-neo',
      classicMarker: 'Месенджери',
      neoMarker: 'Месенджери',
      markerKind: 'heading',
      maxDeltaMs: 1_000,
    },
  ];

  for (const routeComparison of routeComparisons) {
    test(`${routeComparison.name} neo first load is not slower than classic`, async ({
      browser,
    }, testInfo) => {
      const classic = await measureRouteLoad(
        browser,
        routeComparison.classicPath,
        routeComparison.suite,
        routeComparison.markerKind === 'heading'
          ? { kind: 'heading', text: routeComparison.classicMarker }
          : { kind: 'selector', text: routeComparison.classicMarker },
      );
      const neo = await measureRouteLoad(
        browser,
        routeComparison.neoPath,
        routeComparison.suite,
        routeComparison.markerKind === 'heading'
          ? { kind: 'heading', text: routeComparison.neoMarker }
          : { kind: 'selector', text: routeComparison.neoMarker },
      );

      await testInfo.attach(`${routeComparison.name}-classic-load`, {
        body: JSON.stringify(classic, null, 2),
        contentType: 'application/json',
      });
      await testInfo.attach(`${routeComparison.name}-neo-load`, {
        body: JSON.stringify(neo, null, 2),
        contentType: 'application/json',
      });

      expect(neo.markerMs).toBeLessThanOrEqual(classic.markerMs + routeComparison.maxDeltaMs);
    });
  }
});
