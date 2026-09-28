import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { OpenRouterClient, defaultOpenRouterModel } from '@project/common/subtitle-sources/openrouter';

const originalFetch = globalThis.fetch;

const createResponse = ({ ok = true, status = 200, body }: { ok?: boolean; status?: number; body: unknown }) =>
    ({
        ok,
        status,
        text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    }) as unknown as Response;

afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
});

describe('OpenRouterClient', () => {
    it('validates the api key at construction', () => {
        expect(() => new OpenRouterClient({ apiKey: ' ' })).toThrow('OpenRouter API key cannot be empty');
    });

    it('sends a chat completion request and returns the message content', async () => {
        const fetchMock = jest
            .fn<typeof fetch>()
            .mockResolvedValue(createResponse({ body: { choices: [{ message: { content: '{"index": 1}' } }] } }));
        globalThis.fetch = fetchMock;
        const client = new OpenRouterClient({ apiKey: 'sk-or-test' });

        const result = await client.complete([{ role: 'user', content: 'hello' }]);

        expect(result).toBe('{"index": 1}');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-or-test');
        const body = JSON.parse(init?.body as string);
        expect(body.model).toBe(defaultOpenRouterModel);
        expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    });

    it('supports multi-part message content', async () => {
        globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(
            createResponse({
                body: {
                    choices: [
                        {
                            message: {
                                content: [
                                    { type: 'text', text: 'a' },
                                    { type: 'text', text: 'b' },
                                ],
                            },
                        },
                    ],
                },
            })
        );
        const client = new OpenRouterClient({ apiKey: 'key' });

        expect(await client.complete([{ role: 'user', content: 'x' }])).toBe('ab');
    });

    it('surfaces API errors', async () => {
        globalThis.fetch = jest
            .fn<typeof fetch>()
            .mockResolvedValue(
                createResponse({ ok: false, status: 401, body: { error: { message: 'No auth credentials found' } } })
            );
        const client = new OpenRouterClient({ apiKey: 'bad' });

        await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
            'OpenRouter: No auth credentials found'
        );
    });

    it('fails when the response has no content', async () => {
        globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(createResponse({ body: { choices: [] } }));
        const client = new OpenRouterClient({ apiKey: 'key' });

        await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
            'did not contain any message content'
        );
    });
});
