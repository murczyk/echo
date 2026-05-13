/**
 * Single configuration point for where release content lives.
 *
 * Today the releases are served from the local Vite dev server / build output
 * (the `releasesPlugin` reads ./docs/releases from disk and exposes them at
 * `/releases/*`). When this content moves to remote storage, swap the source
 * implementation here without touching the React page.
 */

export interface ReleaseMeta {
  releaseId: string;
  title: string;
}

export interface ReleasesSource {
  /** Returns the list of releases, newest first. */
  listReleases(): Promise<ReleaseMeta[]>;
  /** Returns the raw markdown of a release's release.md. */
  fetchReleaseMarkdown(releaseId: string): Promise<string>;
  /** Resolves a media reference (relative or absolute) from a release.md to a fetchable URL. */
  resolveMediaUrl(releaseId: string, href: string): string;
}

interface ReleaseIndexEntryDto {
  release_id: string;
  title?: string;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function isAbsoluteUrl(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

export function createHttpReleasesSource(baseUrl: string): ReleasesSource {
  const root = stripTrailingSlash(baseUrl);

  return {
    async listReleases() {
      const response = await fetch(`${root}/index.json`, { cache: 'no-cache' });
      if (!response.ok) {
        throw new Error(`Failed to load releases index: HTTP ${response.status}`);
      }
      const raw = (await response.json()) as ReleaseIndexEntryDto[];
      return raw.map((entry) => ({
        releaseId: entry.release_id,
        title: entry.title ?? entry.release_id,
      }));
    },

    async fetchReleaseMarkdown(releaseId) {
      const response = await fetch(`${root}/${encodeURIComponent(releaseId)}/release.md`, {
        cache: 'no-cache',
      });
      if (!response.ok) {
        throw new Error(`Failed to load release ${releaseId}: HTTP ${response.status}`);
      }
      return response.text();
    },

    resolveMediaUrl(releaseId, href) {
      if (isAbsoluteUrl(href)) return href;
      const cleaned = href.replace(/^\.\//, '').replace(/^\/+/, '');
      return `${root}/${encodeURIComponent(releaseId)}/${cleaned}`;
    },
  };
}

function getReleasesBaseUrl(): string {
  const envBase = (import.meta.env as Record<string, string | undefined>).VITE_RELEASES_BASE_URL;
  return envBase && envBase.trim().length > 0 ? envBase : '/releases';
}

let cachedSource: ReleasesSource | null = null;

export function getReleasesSource(): ReleasesSource {
  if (!cachedSource) {
    cachedSource = createHttpReleasesSource(getReleasesBaseUrl());
  }
  return cachedSource;
}
