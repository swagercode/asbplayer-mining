import { asbLog } from '@project/common/util';

export const completeSubtitleSelection = async (systemPrompt: string, userPrompt: string): Promise<string> => {
    const response = await browser.runtime.sendMessage({
        sender: 'asbplayer-subtitle-selector',
        action: 'complete',
        prompt: `${systemPrompt}\n\n${userPrompt}`,
    });
    if (response?.error) {
        throw new Error(response.error);
    }
    if (typeof response?.text !== 'string') {
        throw new Error(
            'The extension did not return a ChatGPT subtitle selection response. Reload the episode to retry.'
        );
    }
    asbLog(
        'video/sync',
        `ChatGPT subtitle selection (${response.model}, ${response.cached ? 'cached' : 'new request'})`
    );
    return response.text;
};
