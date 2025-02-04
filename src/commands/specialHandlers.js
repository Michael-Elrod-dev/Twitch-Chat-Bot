// src/specialHandlers.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const QuoteManager = require('../redemptions/quotes/quoteManager');

const specialHandlers = {
    async followAge(client, target, context, args) {
        const toUser = args[0]?.replace('@', '') || context.username;
        const channel = target.replace('#', '');

        try {
            await client.tokenManager.validateToken('bot');
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
            await client.tokenManager.validateToken('bot');
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
    },

    async currentSong(client, target) {
        try {
            const spotifyManager = global.spotifyManager;
            await spotifyManager.ensureTokenValid();
            const currentTrack = await spotifyManager.spotifyApi.getMyCurrentPlayingTrack();
            
            if (currentTrack.body && currentTrack.body.item) {
                const trackName = currentTrack.body.item.name;
                const artistName = currentTrack.body.item.artists[0].name;
                client.say(target, `Currently playing: ${trackName} by ${artistName}`);
            } else {
                client.say(target, "No song is currently playing in Spotify.");
            }
        } catch (error) {
            console.error('Error fetching current song:', error);
            client.say(target, "Unable to fetch current song information.");
        }
    },

    async lastSong(client, target) {
        try {
            const spotifyManager = global.spotifyManager;
            
            if (spotifyManager.previousTrack) {
                const { name, artist } = spotifyManager.previousTrack;
                client.say(target, `Last played song: ${name} by ${artist}`);
            } else {
                client.say(target, "No previous song information available yet.");
            }
        } catch (error) {
            console.error('Error fetching last song:', error);
            client.say(target, "Unable to fetch last song information.");
        }
    },

    async quoteHandler(client, target, context, args) {
        const quoteManager = new QuoteManager();
        const totalQuotes = quoteManager.getTotalQuotes();
        
        if (totalQuotes === 0) {
            client.say(target, "No quotes saved yet!");
            return;
        }
    
        let quote;
        if (args.length > 0 && !isNaN(args[0])) {
            const id = parseInt(args[0]);
            quote = quoteManager.getQuoteById(id);
            
            if (!quote) {
                client.say(target, `Quote #${id} not found!`);
                return;
            }
        } else {
            quote = quoteManager.getRandomQuote();
        }
    
        const year = new Date(quote.savedAt).getFullYear();
        client.say(target, `Quote #${quote.id}/${totalQuotes} - '${quote.quote}' - ${quote.author}, ${year}`);
    },

    async combinedStats(client, target, context, args) {
        try {
            const chatManager = global.chatManager;
            const requestedUser = args[0]?.replace('@', '').toLowerCase() || context.username.toLowerCase();
            
            const messages = chatManager.getUserMessages(requestedUser);
            const commands = chatManager.getUserCommands(requestedUser);
            const redemptions = chatManager.getUserRedemptions(requestedUser);
            const total = messages + commands + redemptions;
            
            client.say(target, 
                `@${requestedUser} has ${total} total interactions ` +
                `(${messages} messages, ${commands} commands, ${redemptions} redemptions)`
            );
        } catch (error) {
            console.error('Error in combinedStats:', error);
            client.say(target, 'An error occurred while fetching chat stats.');
        }
    },
    
    async topStats(client, target, context, args) {
        try {
            const chatManager = global.chatManager;
            const topUsers = chatManager.getTopFiveUsers();
            client.say(target, `Top 5 Most Active Chatters: ${topUsers.join(' | ')}`);
        } catch (error) {
            console.error('Error in topStats:', error);
            client.say(target, 'An error occurred while fetching top stats.');
        }
    }
};

module.exports = specialHandlers;