// src/specialHandlers.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const specialHandlers = {
    async followAge(client, target, context, args) {
        const toUser = args[0]?.replace('@', '') || context.username;
        const channel = target.replace('#', '');

        try {
            const response = await fetch(`https://commands.garretcharp.com/twitch/followage/${channel}/${toUser}`);
            const followAge = await response.text();
            
            if (followAge.toLowerCase().includes('must login')) {
                client.say(target, 'The channel owner needs to authenticate at https://commands.garretcharp.com/ to enable followage lookups.');
                return;
            }
            
            client.say(target, followAge);
        } catch (error) {
            console.error('Error fetching follow data:', error);
            client.say(target, `Error: ${error.message || 'Unable to fetch follow data'}`);
        }
    },

    async uptime(client, target, context) {
        const channel = target.replace('#', '');
        
        try {
            const clientId = client.getOptions().options.clientId;
            const accessToken = client.getOptions().identity.password.replace('oauth:', '');

            const response = await fetch(`https://api.twitch.tv/helix/streams?user_login=${channel}`, {
                headers: {
                    'Authorization': `Bearer ${accessToken.trim()}`,
                    'Client-Id': clientId.trim()
                }
            });
            
            const data = await response.json();
            
            if (data.data && data.data.length > 0) {
                const startTime = new Date(data.data[0].started_at);
                const now = new Date();
                const diffMs = now - startTime;
                
                const hours = Math.floor(diffMs / 3600000);
                const minutes = Math.floor((diffMs % 3600000) / 60000);
                
                let uptimeStr = '';
                if (hours > 0) uptimeStr += `${hours} hour${hours !== 1 ? 's' : ''} `;
                if (minutes > 0 || hours === 0) uptimeStr += `${minutes} minute${minutes !== 1 ? 's' : ''}`;
                
                client.say(target, `Stream has been live for ${uptimeStr.trim()}`);
            } else {
                client.say(target, `${channel} is not live`);
            }
        } catch (error) {
            console.error('Uptime fetch failed:', error);
            client.say(target, 'Unable to fetch uptime at this time.');
        }
    },

    fursona(client, target, context, args) {
        const hashCode = s => s.split('').reduce((a,b) => {
            a = ((a<<5)-a) + b.charCodeAt(0);
            return a & a;
        }, 0);

        const username = args[0]?.replace('@', '') || context.username;
        const seed = (1 + Math.abs(hashCode(username)) % 99999).toString().padStart(5, '0');
        const url = `https://thisfursonadoesnotexist.com/v2/jpgs-2x/seed${seed}.jpg`;
        
        client.say(target, `@${username}, here is your fursona: ${url}`);
    },

    waifu(client, target, context, args) {
        const hashCode = s => s.split('').reduce((a,b) => {
            a = ((a<<5)-a) + b.charCodeAt(0);
            return a & a;
        }, 0);

        const username = args[0]?.replace('@', '') || context.username;
        const seed = (10000 + Math.abs(hashCode(username)) % 89999).toString().padStart(5, '0');
        const url = `https://arfa.dev/waifu-ed/editor_d6a3dae.html?seed=${seed}`;
        
        client.say(target, `@${username}, here is your cute waifu! ${url} AYAYA`);
    }
};

module.exports = specialHandlers;