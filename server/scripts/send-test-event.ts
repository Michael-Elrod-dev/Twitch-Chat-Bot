/**
 * Posts a correctly-signed synthetic EventSub delivery to a running server.
 *
 * This is the zero-install half of the dev loop: it signs with the same function
 * the webhook verifies with, so it exercises the real HMAC path rather than
 * bypassing it. See README "Local development" for the Twitch CLI, which does
 * the same thing from outside the repo.
 *
 *   npm run dev:event -w server -- --text "!discord" --broadcaster 1001
 */

import {
    chatMessageDelivery,
    streamOnlineDelivery,
    verificationDelivery,
    revocationDelivery,
    type SignedDelivery
} from '../src/transport/eventsub/synthetic.js';
import { EVENTSUB_WEBHOOK_PATH } from '../src/transport/eventsub/webhook.js';
import { DEV_EVENTSUB_SECRET } from '../src/config/env.js';

interface Args {
    url: string;
    secret: string;
    kind: string;
    broadcaster: string;
    text: string;
    chatter: string;
    mod: boolean;
}

function parseArgs(argv: string[]): Args {
    const flags = new Map<string, string>();
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (token?.startsWith('--')) {
            const key = token.slice(2);
            const next = argv[i + 1];
            if (next === undefined || next.startsWith('--')) {
                flags.set(key, 'true');
            } else {
                flags.set(key, next);
                i++;
            }
        }
    }

    return {
        url: flags.get('url') ?? `http://localhost:${process.env['PORT'] ?? '3000'}${EVENTSUB_WEBHOOK_PATH}`,
        secret: flags.get('secret') ?? process.env['TWITCH_EVENTSUB_SECRET'] ?? DEV_EVENTSUB_SECRET,
        kind: flags.get('kind') ?? 'chat',
        broadcaster: flags.get('broadcaster') ?? '1001',
        text: flags.get('text') ?? '!discord',
        chatter: flags.get('chatter') ?? 'testviewer',
        mod: flags.get('mod') === 'true'
    };
}

function build(args: Args): SignedDelivery {
    switch (args.kind) {
    case 'chat':
        return chatMessageDelivery(args.secret, {
            broadcasterUserId: args.broadcaster,
            text: args.text,
            chatterLogin: args.chatter,
            badges: args.mod ? [{ set_id: 'moderator', id: '1', info: '' }] : []
        });
    case 'online':
        return streamOnlineDelivery(args.secret, args.broadcaster);
    case 'verify':
        return verificationDelivery(args.secret, 'challenge-from-dev-script', args.broadcaster);
    case 'revoke':
        return revocationDelivery(args.secret, args.broadcaster);
    default:
        throw new Error(`Unknown --kind ${args.kind} (expected chat, online, verify or revoke)`);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const delivery = build(args);

    const response = await fetch(args.url, {
        method: 'POST',
        headers: delivery.headers,
        body: delivery.body
    });

    const text = await response.text();
    console.log(`${response.status} ${response.statusText}${text ? ` ${text}` : ''}`);

    // A non-2xx here is the same signal Twitch would act on, so it should fail
    // the command rather than print quietly and exit 0.
    if (!response.ok) process.exit(1);
}

void main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
});
