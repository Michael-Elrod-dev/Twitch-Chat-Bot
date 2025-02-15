// src/commands/specialHandlers.js
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const QuoteManager = require('../redemptions/quotes/quoteManager');

const specialHandlers = {
    async followAge(apiClient, channel, context, args) {
        const toUser = args[0]?.replace('@', '') || context.username;

        try {
            const response = await fetch(`https://commands.garretcharp.com/twitch/followage/${channel}/${toUser}`);
            const followAge = await response.text();
            
            if (followAge.toLowerCase().includes('must login')) {
                await apiClient.chat.sendMessage(channel, 'The channel owner needs to authenticate at https://commands.garretcharp.com/ to enable followage lookups.');
                return;
            }
            
            await apiClient.chat.sendMessage(channel, followAge);
        } catch (error) {
            console.error('Error fetching follow data:', error);
            await apiClient.chat.sendMessage(channel, `Error: ${error.message || 'Unable to fetch follow data'}`);
        }
    },

    async uptime(apiClient, channel, context) {
        try {
            const stream = await apiClient.streams.getStreamByUserName(channel);
            
            if (stream) {
                const startTime = new Date(stream.startDate);
                const now = new Date();
                const diffMs = now - startTime;
                
                const hours = Math.floor(diffMs / 3600000);
                const minutes = Math.floor((diffMs % 3600000) / 60000);
                
                let uptimeStr = '';
                if (hours > 0) uptimeStr += `${hours} hour${hours !== 1 ? 's' : ''} `;
                if (minutes > 0 || hours === 0) uptimeStr += `${minutes} minute${minutes !== 1 ? 's' : ''}`;
                
                await apiClient.chat.sendMessage(channel, `Stream has been live for ${uptimeStr.trim()}`);
            } else {
                await apiClient.chat.sendMessage(channel, `${channel} is not live`);
            }
        } catch (error) {
            console.error('Uptime fetch failed:', error);
            await apiClient.chat.sendMessage(channel, 'A fix for this command is coming soon.');
        }
    },

    async fursona(apiClient, channel, context, args) {
        const hashCode = s => s.split('').reduce((a,b) => {
            a = ((a<<5)-a) + b.charCodeAt(0);
            return a & a;
        }, 0);

        const username = args[0]?.replace('@', '') || context.username;
        const seed = (1 + Math.abs(hashCode(username)) % 99999).toString().padStart(5, '0');
        const url = `https://thisfursonadoesnotexist.com/v2/jpgs-2x/seed${seed}.jpg`;
        
        await apiClient.chat.sendMessage(channel, `@${username}, here is your fursona: ${url}`);
    },

    async waifu(apiClient, channel, context, args) {
        const hashCode = s => s.split('').reduce((a,b) => {
            a = ((a<<5)-a) + b.charCodeAt(0);
            return a & a;
        }, 0);

        const username = args[0]?.replace('@', '') || context.username;
        const seed = (10000 + Math.abs(hashCode(username)) % 89999).toString().padStart(5, '0');
        const url = `https://arfa.dev/waifu-ed/editor_d6a3dae.html?seed=${seed}`;
        
        await apiClient.chat.sendMessage(channel, `@${username}, here is your cute waifu! ${url} AYAYA`);
    },

    async currentSong(apiClient, channel) {
        try {
            const spotifyManager = global.spotifyManager;
            await spotifyManager.ensureTokenValid();
            const currentTrack = await spotifyManager.spotifyApi.getMyCurrentPlayingTrack();
            
            if (currentTrack.body && currentTrack.body.item) {
                const trackName = currentTrack.body.item.name;
                const artistName = currentTrack.body.item.artists[0].name;
                await apiClient.chat.sendMessage(channel, `Currently playing: ${trackName} by ${artistName}`);
            } else {
                await apiClient.chat.sendMessage(channel, "No song is currently playing in Spotify.");
            }
        } catch (error) {
            console.error('Error fetching current song:', error);
            await apiClient.chat.sendMessage(channel, "Unable to fetch current song information.");
        }
    },

    async lastSong(apiClient, channel) {
        try {
            const spotifyManager = global.spotifyManager;
            
            if (spotifyManager.previousTrack) {
                const { name, artist } = spotifyManager.previousTrack;
                await apiClient.chat.sendMessage(channel, `Last played song: ${name} by ${artist}`);
            } else {
                await apiClient.chat.sendMessage(channel, "No previous song information available yet.");
            }
        } catch (error) {
            console.error('Error fetching last song:', error);
            await apiClient.chat.sendMessage(channel, "Unable to fetch last song information.");
        }
    },

    async quoteHandler(apiClient, channel, context, args) {
        const quoteManager = new QuoteManager();
        const totalQuotes = quoteManager.getTotalQuotes();
        
        if (totalQuotes === 0) {
            await apiClient.chat.sendMessage(channel, "No quotes saved yet!");
            return;
        }
    
        let quote;
        if (args.length > 0 && !isNaN(args[0])) {
            const id = parseInt(args[0]);
            quote = quoteManager.getQuoteById(id);
            
            if (!quote) {
                await apiClient.chat.sendMessage(channel, `Quote #${id} not found!`);
                return;
            }
        } else {
            quote = quoteManager.getRandomQuote();
        }
    
        const year = new Date(quote.savedAt).getFullYear();
        await apiClient.chat.sendMessage(channel, `Quote #${quote.id}/${totalQuotes} - '${quote.quote}' - ${quote.author}, ${year}`);
    },

    async combinedStats(apiClient, channel, context, args) {
        try {
            const chatManager = global.chatManager;
            const requestedUser = args[0]?.replace('@', '').toLowerCase() || context.username.toLowerCase();
            
            const messages = chatManager.getUserMessages(requestedUser);
            const commands = chatManager.getUserCommands(requestedUser);
            const redemptions = chatManager.getUserRedemptions(requestedUser);
            const total = messages + commands + redemptions;
            
            await apiClient.chat.sendMessage(channel, 
                `@${requestedUser} has ${total} total interactions ` +
                `(${messages} messages, ${commands} commands, ${redemptions} redemptions)`
            );
        } catch (error) {
            console.error('Error in combinedStats:', error);
            await apiClient.chat.sendMessage(channel, 'An error occurred while fetching chat stats.');
        }
    },
    
    async topStats(apiClient, channel, context, args) {
        try {
            const chatManager = global.chatManager;
            const topUsers = chatManager.getTopFiveUsers();
            await apiClient.chat.sendMessage(channel, `Top 5 Most Active Chatters: ${topUsers.join(' | ')}`);
        } catch (error) {
            console.error('Error in topStats:', error);
            await apiClient.chat.sendMessage(channel, 'An error occurred while fetching top stats.');
        }
    },

    async toggleSongs(apiClient, channel, context, args, command) {
        try {
            if (!context.mod && !context.badges?.broadcaster) return;
    
            const channelId = await apiClient.users.getUserByName(channel);
            if (!channelId) {
                console.error('Channel not found');
                return;
            }
    
            // Get all channel rewards
            const rewards = await apiClient.channelPoints.getCustomRewards(channelId.id);
            const songReward = rewards.find(reward => reward.title.toLowerCase() === "song request");
            const skipQueueReward = rewards.find(reward => reward.title.toLowerCase() === "skip song queue");
    
            if (!songReward || !skipQueueReward) {
                await apiClient.chat.sendMessage(channel, "Could not find one or both song-related rewards!");
                return;
            }
    
            const enable = command === '!songson';
            
            // Check if both rewards are already in the desired state
            if (songReward.isEnabled === enable && skipQueueReward.isEnabled === enable) {
                await apiClient.chat.sendMessage(channel, `Song requests are already turned ${enable ? 'on' : 'off'}`);
                return;
            }
    
            // Update both rewards' states
            await Promise.all([
                apiClient.channelPoints.updateCustomReward(channelId.id, songReward.id, {
                    isEnabled: enable
                }),
                apiClient.channelPoints.updateCustomReward(channelId.id, skipQueueReward.id, {
                    isEnabled: enable
                })
            ]);
    
            await apiClient.chat.sendMessage(channel, `Song requests have been turned ${enable ? 'on' : 'off'}`);
        } catch (error) {
            console.error('Error toggling songs:', error);
            await apiClient.chat.sendMessage(channel, `Failed to ${command === '!songson' ? 'enable' : 'disable'} song requests: ${error.message}`);
        }
    },

    async nextSong(apiClient, channel) {
        try {
            const spotifyManager = global.spotifyManager;
            const pendingTracks = spotifyManager.queueManager.getPendingTracks();
            
            if (pendingTracks.length === 0) {
                await apiClient.chat.sendMessage(channel, "There are no songs in the queue.");
                return;
            }
    
            const nextTrack = pendingTracks[0];
            await apiClient.chat.sendMessage(channel, `Next song in queue: ${nextTrack.name} by ${nextTrack.artist} (requested by ${nextTrack.requestedBy})`);
        } catch (error) {
            console.error('Error fetching next song:', error);
            await apiClient.chat.sendMessage(channel, "Unable to fetch next song information.");
        }
    },

    async queueInfo(apiClient, channel, context, args) {
        try {
            const spotifyManager = global.spotifyManager;
            const pendingTracks = spotifyManager.queueManager.getPendingTracks();
            
            if (pendingTracks.length === 0) {
                await apiClient.chat.sendMessage(channel, "The queue is currently empty.");
                return;
            }
    
            // Determine which user to look up
            const requestedUser = args[0] ? args[0].replace('@', '').toLowerCase() : context.username.toLowerCase();
            
            // Find all positions where the user has songs
            const userPositions = pendingTracks
                .map((track, index) => ({ position: index + 1, requestedBy: track.requestedBy }))
                .filter(track => track.requestedBy.toLowerCase() === requestedUser)
                .map(track => track.position);
    
            // Create response message
            let response = `Queue length: ${pendingTracks.length} song${pendingTracks.length !== 1 ? 's' : ''}`;
            
            if (userPositions.length > 0) {
                response += ` | ${requestedUser}'s songs are in position${userPositions.length !== 1 ? 's' : ''}: ${userPositions.join(', ')}`;
            } else {
                response += ` | ${requestedUser} has no songs in queue`;
            }
    
            await apiClient.chat.sendMessage(channel, response);
        } catch (error) {
            console.error('Error fetching queue information:', error);
            await apiClient.chat.sendMessage(channel, "Unable to fetch queue information.");
        }
    },

    async skipSong(apiClient, channel, context) {
        // Only allow mods and broadcaster
        if (!context.mod && !context.badges?.broadcaster) return;
    
        try {
            const spotifyManager = global.spotifyManager;
            await spotifyManager.ensureTokenValid();
    
            // Get current playback state
            const state = await spotifyManager.getPlaybackState();
            if (state === 'CLOSED') {
                await apiClient.chat.sendMessage(channel, "Spotify is not currently active.");
                return;
            }
    
            // Check if there's a song in the queue before skipping
            const pendingTracks = spotifyManager.queueManager.getPendingTracks();
            if (pendingTracks.length > 0) {
                // Add next song to Spotify queue before skipping
                const nextTrack = pendingTracks[0];
                await spotifyManager.spotifyApi.addToQueue(nextTrack.uri);
                spotifyManager.queueManager.removeFirstTrack();
                console.log(`* Added next track to queue before skip: ${nextTrack.name} by ${nextTrack.artist}`);
            }
    
            // Skip the current song
            await spotifyManager.spotifyApi.skipToNext();
            await apiClient.chat.sendMessage(channel, "Skipped to next song!");
    
        } catch (error) {
            console.error('Error skipping song:', error);
            await apiClient.chat.sendMessage(channel, "Unable to skip song. Make sure Spotify is active.");
        }
    }
};

module.exports = specialHandlers;