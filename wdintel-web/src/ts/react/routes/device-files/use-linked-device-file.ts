import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';

import type { DeviceFileRoot, FileBreadcrumb, LocateDeviceFileRsp } from '../../../../Bindings';
import { redirectToLogin } from '../../auth-redirect';
import { isAbortError, isUnauthorizedError } from '../../services/api/client';
import { locateDeviceFile } from '../../services/api/devices';
import { locatedFileSelection, type DeviceFileSelection } from './device-file-archive';
import { toDeviceFileLoadError } from './helpers';
import type { useDeviceFileTree } from './use-device-file-tree';

export type DeviceFileSelectionState = {
  deviceId: string;
  syncId: string | null;
  file: DeviceFileSelection;
  revisionPinned: boolean;
} | null;

function linkedBreadcrumbs(
  located: LocateDeviceFileRsp,
  roots: DeviceFileRoot[],
): FileBreadcrumb[] {
  const path =
    located.file.absolutePath ??
    located.file.virtualPath ??
    located.ancestors.find((entry) => entry.absolutePath)?.absolutePath ??
    '';
  const rootName =
    roots.find((root) => root.entryId === located.rootEntryId)?.name ??
    path.match(/^[a-z]:[\\/]+|^\\\\[^\\/]+[\\/][^\\/]+|^\//i)?.[0] ??
    '';
  return [
    ...(rootName ? [{ entryId: located.rootEntryId, name: rootName, archiveRevision: null }] : []),
    ...located.ancestors.map((entry) => ({
      entryId: entry.entryId,
      name: entry.name,
      archiveRevision: entry.isArchive || entry.archiveOrigin ? entry.revision : null,
    })),
  ];
}

export function useLinkedDeviceFile({
  deviceId,
  syncId,
  enabled,
  linkedFile,
  selection,
  setSelection,
  roots,
  rootsLoading,
  revealFile,
  fileBreadcrumbs,
  setFileBreadcrumbs,
}: {
  deviceId: string;
  syncId: string | null;
  enabled: boolean;
  linkedFile: { fileId: string; revision: number | null } | null;
  selection: DeviceFileSelectionState;
  setSelection: Dispatch<SetStateAction<DeviceFileSelectionState>>;
  roots: DeviceFileRoot[];
  rootsLoading: boolean;
  revealFile: ReturnType<typeof useDeviceFileTree>['revealFile'];
  fileBreadcrumbs: FileBreadcrumb[];
  setFileBreadcrumbs: Dispatch<SetStateAction<FileBreadcrumb[]>>;
}) {
  const [linkError, setLinkError] = useState<string | null>(null);
  const [locatedLink, setLocatedLink] = useState<{
    key: string;
    value: LocateDeviceFileRsp;
  } | null>(null);
  const linkedFileId = linkedFile?.fileId;
  const linkedRevision = linkedFile?.revision ?? null;
  const linkKey = JSON.stringify([deviceId, syncId, linkedFileId, linkedRevision]);
  useEffect(() => {
    setSelection((previous) =>
      linkedFileId &&
      previous?.file.fileId === linkedFileId &&
      (linkedRevision === null || previous.file.revision === linkedRevision)
        ? previous
        : null,
    );
  }, [linkedFileId, linkedRevision]);
  useEffect(() => {
    setLinkError(null);
    if (!enabled || !linkedFileId) {
      setLocatedLink(null);
      return;
    }
    if (
      selection?.deviceId === deviceId &&
      selection.syncId === syncId &&
      selection.file.fileId === linkedFileId &&
      (linkedRevision === null || selection.file.revision === linkedRevision) &&
      (!selection.file.archiveOrigin || fileBreadcrumbs.length > 0)
    )
      return;
    setLocatedLink(null);
    const controller = new AbortController();
    void (async () => {
      try {
        const located = await locateDeviceFile(
          { deviceId, fileId: linkedFileId, revision: linkedRevision },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (syncId !== null && located.file.syncId !== syncId)
          throw new Error('Файл не належить вибраній сесії');
        setFileBreadcrumbs(linkedBreadcrumbs(located, []));
        setSelection({
          deviceId,
          syncId,
          file: locatedFileSelection(located),
          revisionPinned: linkedRevision !== null,
        });
        setLocatedLink({ key: linkKey, value: located });
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) return;
        if (isUnauthorizedError(error)) redirectToLogin();
        setLinkError(
          toDeviceFileLoadError(error, 'Не вдалося відкрити файл за посиланням').message,
        );
      }
    })();
    return () => controller.abort();
  }, [
    deviceId,
    syncId,
    enabled,
    linkedFileId,
    linkedRevision,
    linkKey,
    selection,
    fileBreadcrumbs.length,
    setSelection,
    setFileBreadcrumbs,
  ]);

  const rootsKey = roots.map((root) => root.entryId).join('|');
  useEffect(() => {
    if (!enabled || locatedLink?.key !== linkKey) return;
    const located = locatedLink.value;
    setFileBreadcrumbs(linkedBreadcrumbs(located, roots));
    if (rootsLoading || !roots.some((root) => root.entryId === located.rootEntryId)) return;
    const controller = new AbortController();
    void revealFile(located, controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted || isAbortError(error)) return;
      if (isUnauthorizedError(error)) redirectToLogin();
      setLinkError(toDeviceFileLoadError(error, 'Не вдалося показати файл у дереві').message);
    });
    return () => controller.abort();
  }, [enabled, linkKey, locatedLink, rootsKey, rootsLoading, revealFile, setFileBreadcrumbs]);

  return linkError;
}
