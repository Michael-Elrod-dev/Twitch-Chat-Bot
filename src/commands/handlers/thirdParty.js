// src/commands/handlers/thirdParty.js

function thirdPartyHandlers() {
    function hashCode(str) {
        return str.split('').reduce((a, b) => {
            a = ((a << 5) - a) + b.charCodeAt(0);
            return a & a;
        }, 0);
    }

    function getUserSeed(username, minValue, maxValue) {
        const range = maxValue - minValue;
        const seed = (minValue + Math.abs(hashCode(username)) % range).toString().padStart(5, '0');
        return seed;
    }

    return {
        async fursona(twitchBot, channel, context, args) {
            const username = args[0]?.replace('@', '') || context.username;
            const seed = getUserSeed(username, 1, 100000);
            const url = `https://thisfursonadoesnotexist.com/v2/jpgs-2x/seed${seed}.jpg`;

            await twitchBot.sendMessage(channel, `@${username}, here is your fursona ${url}`);
        },

        async waifu(twitchBot, channel, context, args) {
            const username = args[0]?.replace('@', '') || context.username;
            const seed = getUserSeed(username, 10000, 100000);
            const url = `https://arfa.dev/waifu-ed/editor_d6a3dae.html?seed=${seed}`;

            await twitchBot.sendMessage(channel, `@${username}, here is your waifu ${url}`);
        }
    };
}

module.exports = thirdPartyHandlers;
