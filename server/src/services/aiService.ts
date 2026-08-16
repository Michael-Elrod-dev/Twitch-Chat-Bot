/**
 * The seam the Claude client drops into (P1-WP4.1). This package implements
 * trigger *detection* only - deciding that a message was addressed to the bot -
 * and never calls a model.
 */
export interface AiRequest {
    channelId: string;
    prompt: string;
    chatter: { twitchUserId: string; displayName: string };
    /**
     * The chatter's roles in THIS channel, so the rate limiter can rank them.
     * Optional because the pipeline supplies them and the stub ignores them.
     */
    roles?: {
        isModerator: boolean;
        isVip: boolean;
        isSubscriber: boolean;
        isBroadcaster: boolean;
    };
}

export interface AiResult {
    ok: boolean;
    response?: string;
    message?: string;
}

export interface AiService {
    handleTextRequest: (request: AiRequest) => Promise<AiResult>;
}

/** Records what it was asked and answers nothing. */
export class StubAiService implements AiService {
    readonly requests: AiRequest[] = [];

    async handleTextRequest(request: AiRequest): Promise<AiResult> {
        this.requests.push(request);
        return { ok: false, message: 'AI is not wired up yet' };
    }
}
