/**
 * The seam the Claude client drops into. This module implements trigger
 * detection only, meaning it decides that a message was addressed to the bot,
 * and it never calls a model.
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

/** `!advice` and `!roast`. */
export type GamePromptType = 'advice' | 'roast';

export interface GameRequestTarget {
    twitchUserId: string;
    displayName: string;
}

/**
 * Who pays for the request.
 *
 * Deliberately separate from the target. Charging the target would let
 * `!roast @victim`, repeated a few times, exhaust the victim's allowance and
 * lock them out of the bot, which is griefable by anyone who can type. The
 * person who spends the request is the person who pays for it.
 */
export interface GameRequestRequester {
    twitchUserId: string;
    roles: {
        isModerator: boolean;
        isVip: boolean;
        isSubscriber: boolean;
        isBroadcaster: boolean;
    };
}

export interface AiService {
    handleTextRequest: (request: AiRequest) => Promise<AiResult>;
    handleGameRequest: (
        type: GamePromptType,
        target: GameRequestTarget,
        requester: GameRequestRequester
    ) => Promise<AiResult>;
}

/** Records what it was asked and answers nothing. */
export class StubAiService implements AiService {
    readonly requests: AiRequest[] = [];

    readonly gameRequests: {
        type: GamePromptType;
        target: GameRequestTarget;
        requester: GameRequestRequester;
    }[] = [];

    async handleTextRequest(request: AiRequest): Promise<AiResult> {
        this.requests.push(request);
        return { ok: false, message: 'AI is not wired up yet' };
    }

    async handleGameRequest(
        type: GamePromptType,
        target: GameRequestTarget,
        requester: GameRequestRequester
    ): Promise<AiResult> {
        this.gameRequests.push({ type, target, requester });
        return { ok: false, message: 'AI is not wired up yet' };
    }
}
