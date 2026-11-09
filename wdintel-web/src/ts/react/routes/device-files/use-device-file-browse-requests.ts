import { useEffect, useMemo } from 'react';
import type { BrowseDeviceFilesReq, BrowseDeviceFilesRsp } from '../../../../Bindings';
import { HttpRequestError } from '../../services/api/client';
import { browseDeviceFiles } from '../../services/api/devices';
import { DEVICE_FILE_DIRECTORY_HISTORY_LIMIT } from './types';

type BrowseRequest = {
  controller: AbortController;
  consumers: Set<symbol>;
  breadcrumbs: boolean;
  promise: Promise<BrowseDeviceFilesRsp>;
};

function requestKey(request: BrowseDeviceFilesReq) {
  const key = {
    ...request,
    includeBreadcrumbs: undefined,
    sortBy: request.sortBy ?? 'name',
    sortDirection: request.sortDirection ?? 'ascending',
  };
  if (request.filters) {
    for (const field of [
      'favoritesOnly',
      'unviewedOnly',
      'archiveFailed',
      'archiveEncrypted',
      'hasContent',
      'tagIds',
      'tagMatch',
      'untagged',
    ] as const)
      delete key[field];
  }
  return JSON.stringify(key);
}

function createBrowseRequests() {
  const cached = new Map<
    string,
    {
      response: BrowseDeviceFilesRsp;
      breadcrumbs: boolean;
      parentEntryId: string;
    }
  >();
  const pending = new Map<string, BrowseRequest>();
  const reset = () => {
    cached.clear();
    for (const request of pending.values()) request.controller.abort();
    pending.clear();
  };
  const read: typeof browseDeviceFiles = (request, options) => {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    const key = requestKey(request);
    const breadcrumbs = request.includeBreadcrumbs !== false;
    const previous = cached.get(key);
    if (previous && (!breadcrumbs || previous.breadcrumbs)) {
      cached.delete(key);
      cached.set(key, previous);
      return Promise.resolve(previous.response);
    }
    const pendingKey = `${key}:${breadcrumbs}`;
    let shared = pending.get(`${key}:true`) ?? pending.get(pendingKey);
    if (!shared || shared.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = browseDeviceFiles(request, { ...options, signal: controller.signal })
        .then((response) => {
          if (!controller.signal.aborted && (!cached.get(key)?.breadcrumbs || breadcrumbs)) {
            cached.delete(key);
            cached.set(key, { response, breadcrumbs, parentEntryId: request.parentEntryId });
            if (cached.size > DEVICE_FILE_DIRECTORY_HISTORY_LIMIT)
              cached.delete(cached.keys().next().value!);
          }
          return response;
        })
        .catch((error: unknown) => {
          if (
            !controller.signal.aborted &&
            error instanceof HttpRequestError &&
            [401, 403, 404].includes(error.status)
          )
            reset();
          throw error;
        })
        .finally(() => {
          if (pending.get(pendingKey)?.controller === controller) pending.delete(pendingKey);
        });
      shared = { controller, consumers: new Set(), breadcrumbs, promise };
      pending.set(pendingKey, shared);
    }
    const current = shared;
    return new Promise((resolve, reject) => {
      const consumer = Symbol();
      current.consumers.add(consumer);
      const release = () => {
        signal?.removeEventListener('abort', abort);
        current.consumers.delete(consumer);
      };
      const abort = () => {
        release();
        if (current.consumers.size === 0) current.controller.abort();
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', abort, { once: true });
      current.promise.then(
        (response) => {
          release();
          if (!signal?.aborted) resolve(response);
        },
        (error: unknown) => {
          release();
          reject(error);
        },
      );
    });
  };
  const readFresh: typeof browseDeviceFiles = (request, options) => {
    for (const [key, entry] of cached) {
      if (entry.parentEntryId === request.parentEntryId) cached.delete(key);
    }
    return read(request, options);
  };
  return { read, readFresh, reset };
}

export function useDeviceFileBrowseRequests(scope: string) {
  const requests = useMemo(createBrowseRequests, [scope]);
  useEffect(() => () => requests.reset(), [requests]);
  return requests;
}
