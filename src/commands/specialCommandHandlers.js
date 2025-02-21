// src/commands/specialCommandHandlers.js
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

function specialCommandHandlers(dependencies) {
    const { quoteManager, spotifyManager, viewerManager } = dependencies;
    return {
        async followAge(twitchBot, channel, context, args) {
            const toUser = args[0]?.replace('@', '') || context.username;

            try {
                const response = await fetch(`https://commands.garretcharp.com/twitch/followage/${channel}/${toUser}`);
                const followAge = await response.text();

                if (followAge.toLowerCase().includes('must login')) {
                    await twitchBot.sendMessage(channel, 'The channel owner needs to authenticate at https://commands.garretcharp.com/ to enable followage lookups.');
                    return;
                }

                await twitchBot.sendMessage(channel, followAge);
            } catch (error) {
                console.error('❌ Error fetching follow data:', error);
                await twitchBot.sendMessage(channel, `Error: ${error.message || 'Unable to fetch follow data'}`);
            }
        },

        async uptime(twitchBot, channel, context) {
            try {
                const stream = await twitchBot.streams.getStreamByUserName(channel);

                if (stream) {
                    const startTime = new Date(stream.startDate);
                    const now = new Date();
                    const diffMs = now - startTime;

                    const hours = Math.floor(diffMs / 3600000);
                    const minutes = Math.floor((diffMs % 3600000) / 60000);

                    let uptimeStr = '';
                    if (hours > 0) uptimeStr += `${hours} hour${hours !== 1 ? 's' : ''} `;
                    if (minutes > 0 || hours === 0) uptimeStr += `${minutes} minute${minutes !== 1 ? 's' : ''}`;

                    await twitchBot.sendMessage(channel, `Stream has been live for ${uptimeStr.trim()}`);
                } else {
                    await twitchBot.sendMessage(channel, `${channel} is not live`);
                }
            } catch (error) {
                console.error('Uptime fetch failed:', error);
                await twitchBot.sendMessage(channel, 'A fix for this command is coming soon.');
            }
        },

        async fursona(twitchBot, channel, context, args) {
            const hashCode = s => s.split('').reduce((a, b) => {
                a = ((a << 5) - a) + b.charCodeAt(0);
                return a & a;
            }, 0);

            const username = args[0]?.replace('@', '') || context.username;
            const seed = (1 + Math.abs(hashCode(username)) % 99999).toString().padStart(5, '0');
            const url = `https://thisfursonadoesnotexist.com/v2/jpgs-2x/seed${seed}.jpg`;

            await twitchBot.sendMessage(channel, `@${username}, here is your fursona ${url}`);
        },

        async waifu(twitchBot, channel, context, args) {
            const hashCode = s => s.split('').reduce((a, b) => {
                a = ((a << 5) - a) + b.charCodeAt(0);
                return a & a;
            }, 0);

            const username = args[0]?.replace('@', '') || context.username;
            const seed = (10000 + Math.abs(hashCode(username)) % 89999).toString().padStart(5, '0');
            const url = `https://arfa.dev/waifu-ed/editor_d6a3dae.html?seed=${seed}`;

            await twitchBot.sendMessage(channel, `@${username}, here is your waifu ${url}`);
        },

        async currentSong(twitchBot, channel) {
            try {
                await spotifyManager.ensureTokenValid();
                const currentTrack = await spotifyManager.spotifyApi.getMyCurrentPlayingTrack();

                if (currentTrack.body && currentTrack.body.item) {
                    const trackName = currentTrack.body.item.name;
                    const artistName = currentTrack.body.item.artists[0].name;
                    await twitchBot.sendMessage(channel, `Currently playing: ${trackName} by ${artistName}`);
                } else {
                    await twitchBot.sendMessage(channel, "No song is currently playing in Spotify.");
                }
            } catch (error) {
                console.error('❌ Error fetching current song:', error);
                await twitchBot.sendMessage(channel, "Unable to fetch current song information.");
            }
        },

        async lastSong(twitchBot, channel) {
            try {
                if (spotifyManager.previousTrack) {
                    const { name, artist } = spotifyManager.previousTrack;
                    await twitchBot.sendMessage(channel, `Last played song: ${name} by ${artist}`);
                } else {
                    await twitchBot.sendMessage(channel, "No previous song information available yet.");
                }
            } catch (error) {
                console.error('❌ Error fetching last song:', error);
                await twitchBot.sendMessage(channel, "Unable to fetch last song information.");
            }
        },

        async quoteHandler(twitchBot, channel, context, args) {
            const totalQuotes = quoteManager.getTotalQuotes();

            if (totalQuotes === 0) {
                await twitchBot.sendMessage(channel, "No quotes saved yet!");
                return;
            }

            let quote;
            if (args.length > 0 && !isNaN(args[0])) {
                const id = parseInt(args[0]);
                quote = quoteManager.getQuoteById(id);

                if (!quote) {
                    await twitchBot.sendMessage(channel, `Quote #${id} not found!`);
                    return;
                }
            } else {
                quote = quoteManager.getRandomQuote();
            }

            const year = new Date(quote.savedAt).getFullYear();
            await twitchBot.sendMessage(channel, `Quote #${quote.id}/${totalQuotes} - '${quote.quote}' - ${quote.author}, ${year}`);
        },

        async combinedStats(twitchBot, channel, context, args) {
            try {
                const requestedUser = args[0]?.replace('@', '').toLowerCase() || context.username.toLowerCase();

                const messages = viewerManager.getUserMessages(requestedUser);
                const commands = viewerManager.getUserCommands(requestedUser);
                const redemptions = viewerManager.getUserRedemptions(requestedUser);
                const total = messages + commands + redemptions;

                await twitchBot.sendMessage(channel,
                    `@${requestedUser} has ${total} total interactions ` +
                    `(${messages} messages, ${commands} commands, ${redemptions} redemptions)`
                );
            } catch (error) {
                console.error('❌ Error in combinedStats:', error);
                await twitchBot.sendMessage(channel, 'An error occurred while fetching chat stats.');
            }
        },

        async topStats(twitchBot, channel, context, args) {
            try {
                const topUsers = viewerManager.getTopFiveUsers();
                await twitchBot.sendMessage(channel, `Top 5 Most Active Viewers: ${topUsers.join(' | ')}`);
            } catch (error) {
                console.error('❌ Error in topStats:', error);
                await twitchBot.sendMessage(channel, 'An error occurred while fetching top stats.');
            }
        },

        async toggleSongs(twitchBot, channel, context, args, command) {
            try {
                if (!context.mod && !context.badges?.broadcaster) return;

                const channelId = await twitchBot.users.getUserByName(channel);
                if (!channelId) {
                    console.error('Channel not found');
                    return;
                }

                // Get all channel rewards
                const rewards = await twitchBot.channelPoints.getCustomRewards(channelId.id);
                const songReward = rewards.find(reward => reward.title.toLowerCase() === "song request");
                const skipQueueReward = rewards.find(reward => reward.title.toLowerCase() === "skip song queue");

                if (!songReward || !skipQueueReward) {
                    await twitchBot.sendMessage(channel, "Could not find one or both song-related rewards!");
                    return;
                }

                const enable = command === '!songson';

                // Check if both rewards are already in the desired state
                if (songReward.isEnabled === enable && skipQueueReward.isEnabled === enable) {
                    await twitchBot.sendMessage(channel, `Song requests are already turned ${enable ? 'on' : 'off'}`);
                    return;
                }

                // Update both rewards' states
                await Promise.all([
                    twitchBot.channelPoints.updateCustomReward(channelId.id, songReward.id, {
                        isEnabled: enable
                    }),
                    twitchBot.channelPoints.updateCustomReward(channelId.id, skipQueueReward.id, {
                        isEnabled: enable
                    })
                ]);

                await twitchBot.sendMessage(channel, `Song requests have been turned ${enable ? 'on' : 'off'}`);
            } catch (error) {
                console.error('❌ Error toggling songs:', error);
                await twitchBot.sendMessage(channel, `Failed to ${command === '!songson' ? 'enable' : 'disable'} song requests: ${error.message}`);
            }
        },

        async nextSong(twitchBot, channel) {
            try {
                const pendingTracks = spotifyManager.queueManager.getPendingTracks();

                if (pendingTracks.length === 0) {
                    await twitchBot.sendMessage(channel, "There are no songs in the queue.");
                    return;
                }

                const nextTrack = pendingTracks[0];
                await twitchBot.sendMessage(channel, `Next song in queue: ${nextTrack.name} by ${nextTrack.artist} (requested by ${nextTrack.requestedBy})`);
            } catch (error) {
                console.error('❌ Error fetching next song:', error);
                await twitchBot.sendMessage(channel, "Unable to fetch next song information.");
            }
        },

        async queueInfo(twitchBot, channel, context, args) {
            try {
                const pendingTracks = spotifyManager.queueManager.getPendingTracks();

                if (pendingTracks.length === 0) {
                    await twitchBot.sendMessage(channel, "The queue is currently empty.");
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

                await twitchBot.sendMessage(channel, response);
            } catch (error) {
                console.error('❌ Error fetching queue information:', error);
                await twitchBot.sendMessage(channel, "Unable to fetch queue information.");
            }
        },

        async skipSong(twitchBot, channel, context) {
            if (!context.mod && !context.badges?.broadcaster) return;
            try {
                await spotifyManager.ensureTokenValid();
                const state = await spotifyManager.getPlaybackState();
                
                if (state === 'CLOSED') {
                    await twitchBot.sendMessage(channel, "Spotify is not currently active.");
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
                await twitchBot.sendMessage(channel, "Skipped to next song!");

            } catch (error) {
                console.error('❌ Error skipping song:', error);
                await twitchBot.sendMessage(channel, "Unable to skip song. Make sure Spotify is active.");
            }
        }
    };
}

module.exports = specialCommandHandlers;