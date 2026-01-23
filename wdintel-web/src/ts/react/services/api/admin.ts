export type RestartEchoPayload = {
  restartPostgres: boolean;
  restartOutdatedSources: boolean;
};

type RestartEchoRequestBody = {
  restart_postgres: boolean;
  restart_outdated_sources: boolean;
};

function toRestartEchoRequestBody(payload: RestartEchoPayload): RestartEchoRequestBody {
  return {
    restart_postgres: payload.restartPostgres,
    restart_outdated_sources: payload.restartOutdatedSources,
  };
}

async function parseErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    try {
      const data = await response.json();
      if (typeof data === 'string') return data;
      if (data && typeof data === 'object') {
        const knownMessage = data.error || data.message || data.detail;
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

export async function restartEcho(payload: RestartEchoPayload): Promise<boolean> {
  const response = await fetch('/api/admin/restart-echo', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify(toRestartEchoRequestBody(payload)),
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new Error(message);
  }

  return (await response.json()) as boolean;
}
