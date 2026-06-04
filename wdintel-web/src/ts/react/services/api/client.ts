import { emitUnauthorizedEvent } from '../../auth-redirect';

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type JsonRequestObject = { [key: string]: JsonValue | undefined };
export type JsonBody = JsonValue | JsonObject | JsonRequestObject;

type HttpMethod = 'POST' | 'PUT' | 'DELETE' | 'GET';
type RequestOptions = {
  signal?: AbortSignal;
};

export class HttpRequestError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'HttpRequestError';
    this.status = status;
  }
}

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof HttpRequestError && error.status === 401;
}

export async function tryRunAndReturnNullExceptUnauthorized<T>(request: () => Promise<T>): Promise<T | null> {
  try {
    return await request();
  } catch (error) {
    if (isUnauthorizedError(error)) {
      throw error;
    }
    return null;
  }
}

async function parseErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      if (typeof data === 'string') return data;
      if (data && typeof data === 'object') {
        const knownMessage =
          typeof data === 'object' && data !== null
            ? (data as Record<string, unknown>).error ?? (data as Record<string, unknown>).message ?? (data as Record<string, unknown>).detail
            : undefined;
        if (typeof knownMessage === 'string' && knownMessage.trim().length > 0) return knownMessage;
        return JSON.stringify(data);
      }
    } catch (_) {
      // fall through to text
    }
  }

  const text = await response.text();
  if (text.trim().length > 0) return text;

  return response.statusText || `HTTP ${response.status}`;
}

async function requestJson<T>(
  method: HttpMethod,
  url: string,
  body?: JsonBody,
  options?: RequestOptions,
) {
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    signal: options?.signal,
  };

  if (method !== 'GET') {
    init.body = body === undefined ? undefined : JSON.stringify(body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    if (response.status === 401) {
      emitUnauthorizedEvent();
    }
    const message = await parseErrorMessage(response);
    throw new HttpRequestError(response.status, message);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (!text.trim()) return undefined as T;

  try {
    return JSON.parse(text) as T;
  } catch (_) {
    return text as T;
  }
}

async function requestBytes(
  method: HttpMethod,
  url: string,
  body?: JsonBody,
  options?: RequestOptions,
) {
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    signal: options?.signal,
  };

  if (method !== 'GET') {
    init.body = body === undefined ? undefined : JSON.stringify(body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    if (response.status === 401) {
      emitUnauthorizedEvent();
    }
    const message = await parseErrorMessage(response);
    throw new HttpRequestError(response.status, message);
  }

  return response.blob();
}

export async function postJson<T>(url: string, body?: JsonBody, options?: RequestOptions) {
  return requestJson<T>('POST', url, body, options);
}

export async function postBytes(url: string, body?: JsonBody, options?: RequestOptions) {
  return requestBytes('POST', url, body, options);
}

export async function getJson<T>(url: string, options?: RequestOptions) {
  return requestJson<T>('GET', url, undefined, options);
}

export async function postVoid(url: string, body?: JsonBody, options?: RequestOptions) {
  await requestJson('POST', url, body, options);
}

export async function putJson<T>(url: string, body?: JsonBody, options?: RequestOptions) {
  return requestJson<T>('PUT', url, body, options);
}

export async function putVoid(url: string, body?: JsonBody, options?: RequestOptions) {
  await requestJson('PUT', url, body, options);
}

export async function deleteVoid(url: string, body?: JsonBody, options?: RequestOptions) {
  await requestJson('DELETE', url, body, options);
}
