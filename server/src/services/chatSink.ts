import type { Logger } from '../logger.js';

/**
 * The bot's outbound seam.
 *
 * Every reply the pipeline produces leaves through here, so changing where
 * replies go is one implementation swap rather than a search for `sendMessage`
 * call sites. It also means rate limiting, truncation and per-channel muting
 * have exactly one place to live.
 */
export interface OutboundMessage {
    channelId: string;
    broadcasterTwitchId: string;
    text: string;
}

export interface ChatSink {
    send: (message: OutboundMessage) => Promise<void>;
}

/**
 * Writes what would have been said.
 *
 * Not a placeholder to be embarrassed about: until tokens exist this is how the
 * end-to-end path is observed, and a structured line per outbound message is
 * what makes "did the command actually reach chat" answerable from the logs.
 */
export class LoggingChatSink implements ChatSink {
    private readonly logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    async send({ channelId, broadcasterTwitchId, text }: OutboundMessage): Promise<void> {
        this.logger.info(
            { channelId, broadcasterTwitchId, text, sink: 'logging' },
            'CHAT SEND'
        );
    }
}

/** Keeps every message for assertions. */
export class RecordingChatSink implements ChatSink {
    readonly sent: OutboundMessage[] = [];

    async send(message: OutboundMessage): Promise<void> {
        this.sent.push(message);
    }

    textsFor(channelId: string): string[] {
        return this.sent.filter((m) => m.channelId === channelId).map((m) => m.text);
    }
}
