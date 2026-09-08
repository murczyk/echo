import { emitUnauthorizedEvent } from '../../auth-redirect';

type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type JsonRequestObject = { [key: string]: JsonValue | undefined };
export type JsonBody = JsonValue | JsonObject | JsonRequestObject;

type HttpMethod = 'POST' | 'PUT' | 'DELETE' | 'GET';
export type RequestOptions = {
  headers?: Record<string, string>;
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
export function isNetworkRequestError(error: unknown): boolean {
  return error instanceof HttpRequestError && error.status === 0;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

const NETWORK_REQUEST_ERROR_MESSAGE =
  'Не вдалося підключитися до сервера. Перевірте мережу та спробуйте ще раз.';

function httpStatusMessage(status: number): string {
  return `Помилка сервера (${status}).`;
}

function isHtmlDocument(text: string): boolean {
  return /^\s*(?:<!doctype\s+html\b|<html(?:\s|>))/i.test(text);
}

function errorMessageFromJson(data: unknown): string | null {
  if (typeof data === 'string' && data.trim().length > 0) return data;
  if (!data || typeof data !== 'object') return null;
  const knownMessage =
    (data as Record<string, unknown>).error ??
    (data as Record<string, unknown>).message ??
    (data as Record<string, unknown>).detail;
  if (typeof knownMessage === 'string' && knownMessage.trim().length > 0) {
    return knownMessage;
  }
  return JSON.stringify(data);
}

export async function tryRunAndReturnNullExceptUnauthorized<T>(
  request: () => Promise<T>,
): Promise<T | null> {
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
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const text = await response.text();

  if (contentType.includes('text/html') || isHtmlDocument(text)) {
    return httpStatusMessage(response.status);
  }
  if (text.trim().length === 0) return httpStatusMessage(response.status);

  try {
    const message = errorMessageFromJson(JSON.parse(text));
    if (message !== null) return message;
  } catch (_) {
    if (contentType.includes('json')) return httpStatusMessage(response.status);
    return text;
  }

  return text;
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
      ...options?.headers,
    },
    credentials: 'include',
    signal: options?.signal,
  };

  if (method !== 'GET') {
    init.body = body === undefined ? undefined : JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new HttpRequestError(0, NETWORK_REQUEST_ERROR_MESSAGE);
  }

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
      ...options?.headers,
    },
    credentials: 'include',
    signal: options?.signal,
  };

  if (method !== 'GET') {
    init.body = body === undefined ? undefined : JSON.stringify(body);
  }

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new HttpRequestError(0, NETWORK_REQUEST_ERROR_MESSAGE);
  }

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

export async function postFormData<T>(
  url: string,
  body: FormData,
  options?: RequestOptions,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      body,
      credentials: 'include',
      headers: options?.headers,
      signal: options?.signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new HttpRequestError(0, NETWORK_REQUEST_ERROR_MESSAGE);
  }
  if (!response.ok) {
    if (response.status === 401) emitUnauthorizedEvent();
    const message = await parseErrorMessage(response);
    throw new HttpRequestError(response.status, message);
  }
  return (await response.json()) as T;
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
