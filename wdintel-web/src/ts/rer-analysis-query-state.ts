export type RerAnalysisQueryState = {
    search?: string;
    [key: string]: unknown;
};

export const RER_ANALYSIS_QUERY_STATE_KEY = 'rer-analysis-query-state';

export function saveRerAnalysisQueryState(state: unknown): void {
    try {
        const serialized = JSON.stringify(state);
        localStorage.setItem(RER_ANALYSIS_QUERY_STATE_KEY, serialized);
    } catch (error) {
        console.error('Failed to save rer analysis query state', error);
    }
}

export function loadRerAnalysisQueryState(): RerAnalysisQueryState | null {
    try {
        const stored = localStorage.getItem(RER_ANALYSIS_QUERY_STATE_KEY);

        if (!stored) {
            return null;
        }

        const parsed = JSON.parse(stored);

        if (parsed && typeof parsed === 'object') {
            return parsed as RerAnalysisQueryState;
        }
    } catch (error) {
        console.error('Failed to load rer analysis query state', error);
    }

    return null;
}
