export interface OpenRouterMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface OpenRouterClientOptions {
    apiKey: string;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
}

// OpenRouter's "Free Models Router" picks a currently-available free model
// per request, so the feature keeps working as individual free models come and go.
export const defaultOpenRouterModel = 'openrouter/free';

const defaultOpenRouterBaseUrl = 'https://openrouter.ai/api/v1';

interface OpenRouterChatCompletionResponse {
    choices?: {
        message?: {
            content?: string | { type?: string; text?: string }[] | null;
        };
    }[];
    error?: {
        message?: string;
        code?: number | string;
    };
}

const parseJsonSafely = (text: string): unknown | undefined => {
    if (text.length === 0) {
        return undefined;
    }

    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
};

const contentToText = (content: string | { type?: string; text?: string }[] | null | undefined): string | undefined => {
    if (typeof content === 'string') {
        return content;
    }

    if (Array.isArray(content)) {
        const text = content
            .map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .join('')
            .trim();
        return text.length > 0 ? text : undefined;
    }

    return undefined;
};

export class OpenRouterClient {
    private readonly _apiKey: string;
    private readonly _model: string;
    private readonly _baseUrl: string;
    private readonly _timeoutMs: number;

    constructor({
        apiKey,
        model = defaultOpenRouterModel,
        baseUrl = defaultOpenRouterBaseUrl,
        timeoutMs = 30000,
    }: OpenRouterClientOptions) {
        const trimmedApiKey = apiKey.trim();

        if (trimmedApiKey.length === 0) {
            throw new Error('OpenRouter API key cannot be empty or whitespace-only');
        }

        this._apiKey = trimmedApiKey;
        this._model = model;
        this._baseUrl = baseUrl;
        this._timeoutMs = timeoutMs;
    }

    get model() {
        return this._model;
    }

    async complete(messages: OpenRouterMessage[]): Promise<string> {
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        const timeout =
            controller === undefined || this._timeoutMs <= 0
                ? undefined
                : setTimeout(() => controller.abort(), this._timeoutMs);

        let response: Response;

        try {
            response = await fetch(`${this._baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${this._apiKey}`,
                    'Content-Type': 'application/json',
                    // Optional attribution headers recommended by OpenRouter
                    'HTTP-Referer': 'https://github.com/killergerbah/asbplayer',
                    'X-Title': 'asbplayer',
                },
                body: JSON.stringify({
                    model: this._model,
                    messages,
                    temperature: 0,
                }),
                signal: controller?.signal,
            });
        } catch (e) {
            if ((e as Error)?.name === 'AbortError') {
                throw new Error(`OpenRouter request timed out after ${this._timeoutMs}ms`);
            }

            throw e;
        } finally {
            if (timeout !== undefined) {
                clearTimeout(timeout);
            }
        }

        const bodyText = await response.text();
        const parsedBody = parseJsonSafely(bodyText) as OpenRouterChatCompletionResponse | undefined;

        if (!response.ok || parsedBody?.error !== undefined) {
            const errorMessage =
                parsedBody?.error?.message ?? `OpenRouter request failed with status ${response.status}`;
            throw new Error(`OpenRouter: ${errorMessage}`);
        }

        const text = contentToText(parsedBody?.choices?.[0]?.message?.content);

        if (text === undefined) {
            throw new Error('OpenRouter: response did not contain any message content');
        }

        return text;
    }
}
