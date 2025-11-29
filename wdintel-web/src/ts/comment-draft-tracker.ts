const STORAGE_KEY = 'rer-analysis-comment-draft-events';
const ENDPOINT = '/api/rer/analysis/message-draft-events';
const MAX_BATCH_SIZE = 20;
const SEND_INTERVAL_MS = 10_000;
const MAX_QUEUE_SIZE = 500;
const MAX_VALUE_LENGTH = 2000;

type DraftEvent = {
    id: string;
    message_id: number;
    value: string;
    created_at_ms: number;
};

const parseQueue = (): DraftEvent[] => {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);

        if (!stored) {
            return [];
        }

        const parsed = JSON.parse(stored);

        if (!Array.isArray(parsed)) {
            return [];
        }

        return parsed.filter((item): item is DraftEvent => {
            return (
                typeof item === 'object'
                && item !== null
                && typeof (item as any).id === 'string'
                && typeof (item as any).message_id === 'number'
                && typeof (item as any).value === 'string'
                && typeof (item as any).created_at_ms === 'number'
            );
        });
    } catch (error) {
        console.warn('Failed to parse draft queue', error);
        return [];
    }
};

const persistQueue = (queue: DraftEvent[]): void => {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    } catch (error) {
        console.warn('Failed to persist draft queue', error);
    }
};

const enqueueEvent = (event: DraftEvent): void => {
    const queue = parseQueue();
    queue.push(event);

    if (queue.length > MAX_QUEUE_SIZE) {
        queue.splice(0, queue.length - MAX_QUEUE_SIZE);
    }

    persistQueue(queue);
};

const removeEvents = (ids: Set<string>): void => {
    const queue = parseQueue();
    const filtered = queue.filter((evt) => !ids.has(evt.id));
    persistQueue(filtered);
};

const createId = (): string => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
};

const recordDraftEvent = (messageId: number, value: string): void => {
    const trimmed = value.trim();

    if (!trimmed) {
        return;
    }

    const queue = parseQueue();
    const lastEvent = queue[queue.length - 1];

    if (lastEvent && lastEvent.message_id === messageId && lastEvent.value === trimmed) {
        return;
    }

    const limitedValue = trimmed.slice(0, MAX_VALUE_LENGTH);

    enqueueEvent({
        id: createId(),
        message_id: messageId,
        value: limitedValue,
        created_at_ms: Date.now(),
    });
};

let sendInProgress = false;

const flushDraftEvents = async (): Promise<void> => {
    if (sendInProgress) {
        return;
    }

    const queue = parseQueue();

    if (queue.length === 0) {
        return;
    }

    const batch = queue.slice(0, MAX_BATCH_SIZE);

    sendInProgress = true;

    try {
        const response = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            credentials: 'same-origin',
            body: JSON.stringify({ events: batch }),
        });

        if (response.ok) {
            const sentIds = new Set(batch.map((evt) => evt.id));
            removeEvents(sentIds);
        } else {
            console.warn('Failed to send draft events', response.status, response.statusText);
        }
    } catch (error) {
        console.warn('Failed to send draft events', error);
    } finally {
        sendInProgress = false;
    }
};

const handleTextareaInput = (event: Event): void => {
    const target = event.target;

    if (!(target instanceof HTMLTextAreaElement)) {
        return;
    }

    if (target.dataset.commentDraft !== 'rer-analysis') {
        return;
    }

    const messageId = Number.parseInt(target.dataset.messageId || '', 10);

    if (Number.isNaN(messageId)) {
        return;
    }

    recordDraftEvent(messageId, target.value);
};

export const setupCommentDraftTracker = (): void => {
    document.addEventListener('input', handleTextareaInput, true);
    flushDraftEvents();
    window.setInterval(flushDraftEvents, SEND_INTERVAL_MS);
};
