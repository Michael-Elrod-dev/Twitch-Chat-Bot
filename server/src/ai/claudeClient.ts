import Anthropic from '@anthropic-ai/sdk';
import type { Logger } from '../logger.js';

/**
 * The Claude client.
 *
 * The official SDK replaces Phase 0's hand-rolled fetch client, which had to
 * reimplement retries, error shapes and streaming for itself. Everything the
 * bot needs from it is behind this interface, so the AI service can be tested
 * end to end without a network — and without an API key existing at all.
 *
 * **The API key is a server secret.** It comes from the environment, is never
 * per-channel, never stored in the database, and never logged. A channel
 * connecting to the bot does not bring its own key and cannot see ours.
 */

export interface CompletionRequest {
    system: string;
    userMessage: string;
    maxTokens: number;
}

export interface CompletionResult {
    ok: boolean;
    text?: string;
    /** Why it failed, for logs. Never contains the key or the prompt. */
    reason?: string;
}

export interface ClaudeClient {
    complete: (request: CompletionRequest) => Promise<CompletionResult>;
}

export interface AnthropicClientOptions {
    apiKey: string;
    model: string;
    logger: Logger;
    timeoutMs?: number;
}

/** Chat is live: a reply nobody is still waiting for is worse than no reply. */
const DEFAULT_TIMEOUT_MS = 20_000;

export class AnthropicClaudeClient implements ClaudeClient {
    private readonly client: Anthropic;
    private readonly model: string;
    private readonly logger: Logger;

    constructor(options: AnthropicClientOptions) {
        this.client = new Anthropic({
            apiKey: options.apiKey,
            timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            // The SDK retries 429s and 5xxs by default. A 4xx is our mistake -
            // a malformed request or a bad key - and retrying it just spends
            // the timeout budget before failing the same way.
            maxRetries: 1
        });
        this.model = options.model;
        this.logger = options.logger;
    }

    async complete(request: CompletionRequest): Promise<CompletionResult> {
        try {
            const response = await this.client.messages.create({
                model: this.model,
                max_tokens: request.maxTokens,
                system: request.system,
                messages: [{ role: 'user', content: request.userMessage }]
            });

            // The content is a block array; only text blocks are meaningful for
            // a chat reply, and joining them keeps a multi-block answer intact.
            const text = response.content
                .filter((block): block is Anthropic.TextBlock => block.type === 'text')
                .map((block) => block.text)
                .join('')
                .trim();

            if (text === '') {
                return { ok: false, reason: 'model returned no text' };
            }

            return { ok: true, text };
        } catch (err) {
            // Deliberately does not include the request: the prompt carries
            // chat content, and the error carries nothing we need beyond why.
            const reason = err instanceof Anthropic.APIError
                ? `${err.status ?? 'network'}: ${err.name}`
                : (err as Error).message;

            this.logger.error({ reason, model: this.model }, 'Claude request failed');
            return { ok: false, reason };
        }
    }
}

/**
 * Deterministic stand-in for tests and for a server with no key configured.
 *
 * Records what it was asked so a test can assert on the built prompt, which is
 * how the prompt-building and rate-limiting behaviour is verified without ever
 * reaching the network.
 */
export class FakeClaudeClient implements ClaudeClient {
    readonly requests: CompletionRequest[] = [];

    /** Set to make the next call fail, for the fallback-message path. */
    failNext = false;
    reply = 'a fake reply';

    async complete(request: CompletionRequest): Promise<CompletionResult> {
        this.requests.push(request);

        if (this.failNext) {
            this.failNext = false;
            return { ok: false, reason: 'fake failure' };
        }

        return { ok: true, text: this.reply };
    }
}

/**
 * What runs when no API key is configured.
 *
 * Fails rather than pretending: the caller's fallback path then produces the
 * channel's configured message, which is the same thing a real outage does.
 */
export class UnconfiguredClaudeClient implements ClaudeClient {
    async complete(): Promise<CompletionResult> {
        return { ok: false, reason: 'ANTHROPIC_API_KEY is not configured' };
    }
}
