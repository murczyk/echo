type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };

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

async function requestJson<T>(url: string, body?: JsonValue | JsonObject) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function postJson<T>(url: string, body?: JsonValue | JsonObject) {
  return requestJson<T>(url, body);
}

export async function postVoid(url: string, body?: JsonValue | JsonObject) {
  await requestJson(url, body);
}
