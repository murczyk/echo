type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

type HttpMethod = 'POST' | 'PUT' | 'DELETE' | 'GET';
async function parseErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      if (typeof data === 'string') return data;
      if (data && typeof data === 'object') {
        const knownMessage = (data as any).error || (data as any).message || (data as any).detail;
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

async function requestJson<T>(method: HttpMethod, url: string, body?: JsonValue | JsonObject) {
  const init: RequestInit = {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
  };

  if (method !== 'GET') {
    init.body = body === undefined ? undefined : JSON.stringify(body);
  }

  const response = await fetch(url, init);

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(message);
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

export async function postJson<T>(url: string, body?: JsonValue | JsonObject) {
  return requestJson<T>('POST', url, body);
}

export async function getJson<T>(url: string) {
  return requestJson<T>('GET', url);
}

export async function postVoid(url: string, body?: JsonValue | JsonObject) {
  await requestJson('POST', url, body);
}

export async function putJson<T>(url: string, body?: JsonValue | JsonObject) {
  return requestJson<T>('PUT', url, body);
}

export async function putVoid(url: string, body?: JsonValue | JsonObject) {
  await requestJson('PUT', url, body);
}

export async function deleteVoid(url: string, body?: JsonValue | JsonObject) {
  await requestJson('DELETE', url, body);
}
