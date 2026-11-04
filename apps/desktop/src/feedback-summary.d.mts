export interface FeedbackErrorRecord { at: string; source: string; detail: string }
export function limitFeedbackText(value: string, maxBytes?: number): string
export function summarizeErrors(records: FeedbackErrorRecord[]): string[]
export function extractLogErrors(logs?: Record<string, string>): FeedbackErrorRecord[]
