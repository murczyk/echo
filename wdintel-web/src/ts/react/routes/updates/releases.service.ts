export interface ReleaseMeta {
  releaseId: string;
  title: string;
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

function getReleasesRoot(): string {
  const envBase = (import.meta.env as unknown as Record<string, string | undefined>).VITE_RELEASES_BASE_URL;
  return stripTrailingSlash(envBase && envBase.trim().length > 0 ? envBase : '/releases');
}

const releasesRoot = getReleasesRoot();

export async function fetchReleasesIndex(): Promise<ReleaseMeta[]> {
  const response = await fetch(`${releasesRoot}/index.json`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load releases index: HTTP ${response.status}`);
  }
  const raw = (await response.json()) as ReleaseIndexEntryDto[];
  return raw.map((entry) => ({
    releaseId: entry.release_id,
    title: entry.title ?? entry.release_id,
  }));
}

export async function fetchReleaseMarkdown(releaseId: string): Promise<string> {
  const response = await fetch(`${releasesRoot}/${encodeURIComponent(releaseId)}/release.md`, {
    cache: 'no-cache',
  });
  if (!response.ok) {
    throw new Error(`Failed to load release ${releaseId}: HTTP ${response.status}`);
  }
  return response.text();
}

export function resolveReleaseMediaUrl(releaseId: string, href: string): string {
  if (isAbsoluteUrl(href)) return href;
  const cleaned = href.replace(/^\.\//, '').replace(/^\/+/, '');
  return `${releasesRoot}/${encodeURIComponent(releaseId)}/${cleaned}`;
}
