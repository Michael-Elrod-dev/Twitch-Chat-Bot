// src/commands/specialCommandHandlers.js

const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const logger = require('../logger/logger');

function specialCommandHandlers(dependencies) {
    const { quoteManager, spotifyManager } = dependencies;
    return {
        async followAge(twitchBot, channel, context, args) {
            const toUser = args[0]?.replace('@', '') || context.username;

            logger.debug('SpecialCommandHandlers', 'Fetching followage', {
                channel,
                toUser,
                requestedBy: context.username
            });

            try {
                const response = await fetch(`https://commands.garretcharp.com/twitch/followage/${channel}/${toUser}`);
                const followAge = await response.text();

                if (followAge.toLowerCase().includes('must login')) {
                    await twitchBot.sendMessage(channel, 'The channel owner needs to authenticate at https://commands.garretcharp.com/ to enable followage lookups.');
                    return;
                }

                await twitchBot.sendMessage(channel, followAge);
                logger.info('SpecialCommandHandlers', 'Followage command executed', {
                    channel,
                    toUser,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error fetching follow data', { error: error.message, stack: error.stack, channel, toUser });
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
                    logger.info('SpecialCommandHandlers', 'Uptime command executed', {
                        channel,
                        uptimeMs: diffMs,
                        requestedBy: context.username
                    });
                } else {
                    await twitchBot.sendMessage(channel, `${channel} is not live`);
                    logger.debug('SpecialCommandHandlers', 'Uptime checked - stream not live', { channel });
                }
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Uptime fetch failed', { error: error.message, stack: error.stack, channel });
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
                    logger.info('SpecialCommandHandlers', 'Current song command executed', {
                        channel,
                        trackName,
                        artistName
                    });
                } else {
                    await twitchBot.sendMessage(channel, 'No song is currently playing in Spotify.');
                    logger.debug('SpecialCommandHandlers', 'No song currently playing', { channel });
                }
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error fetching current song', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Unable to fetch current song information.');
            }
        },

        async lastSong(twitchBot, channel) {
            try {
                if (spotifyManager.previousTrack) {
                    const { name, artist } = spotifyManager.previousTrack;
                    await twitchBot.sendMessage(channel, `Last played song: ${name} by ${artist}`);
                    logger.info('SpecialCommandHandlers', 'Last song command executed', {
                        channel,
                        trackName: name,
                        artistName: artist
                    });
                } else {
                    await twitchBot.sendMessage(channel, 'No previous song information available yet.');
                    logger.debug('SpecialCommandHandlers', 'No previous song available', { channel });
                }
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error fetching last song', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Unable to fetch last song information.');
            }
        },

        async quoteHandler(twitchBot, channel, context, args) {
            try {
                if (!quoteManager.dbManager) {
                    await quoteManager.init(twitchBot.analyticsManager.dbManager);
                }

                const totalQuotes = await quoteManager.getTotalQuotes();

                if (totalQuotes === 0) {
                    await twitchBot.sendMessage(channel, 'No quotes saved yet!');
                    return;
                }

                let quote;
                if (args.length > 0 && !isNaN(args[0])) {
                    const id = parseInt(args[0]);
                    quote = await quoteManager.getQuoteById(id);

                    if (!quote) {
                        await twitchBot.sendMessage(channel, `Quote #${id} not found!`);
                        logger.debug('SpecialCommandHandlers', 'Quote not found', { channel, quoteId: id });
                        return;
                    }
                } else {
                    quote = await quoteManager.getRandomQuote();
                }

                const year = new Date(quote.savedAt).getFullYear();
                await twitchBot.sendMessage(channel, `Quote #${quote.id}/${totalQuotes} - '${quote.quote}' - ${quote.author}, ${year}`);
                logger.info('SpecialCommandHandlers', 'Quote command executed', {
                    channel,
                    quoteId: quote.id,
                    totalQuotes,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error in quote handler', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Sorry, there was an error retrieving quotes.');
            }
        },

        async combinedStats(twitchBot, channel, context, args) {
            let requestedUser;
            try {
                requestedUser = args[0]?.replace('@', '').toLowerCase() || context.username.toLowerCase();
                const messages = await twitchBot.viewerManager.getUserMessages(requestedUser);
                const commands = await twitchBot.viewerManager.getUserCommands(requestedUser);
                const redemptions = await twitchBot.viewerManager.getUserRedemptions(requestedUser);
                const total = messages + commands + redemptions;

                await twitchBot.sendMessage(channel,
                    `@${requestedUser} has ${total} total interactions ` +
                    `(${messages} messages, ${commands} commands, ${redemptions} redemptions)`
                );
                logger.info('SpecialCommandHandlers', 'Combined stats command executed', {
                    channel,
                    targetUser: requestedUser,
                    total,
                    messages,
                    commands,
                    redemptions,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error in combinedStats', { error: error.message, stack: error.stack, channel, targetUser: requestedUser });
                await twitchBot.sendMessage(channel, 'An error occurred while fetching chat stats.');
            }
        },

        async topStats(twitchBot, channel, context) {
            try {
                if (!twitchBot.viewerManager && twitchBot.analyticsManager?.viewerTracker) {
                    logger.debug('SpecialCommandHandlers', 'Using viewerTracker directly for topStats', { channel });
                    const topUsers = await twitchBot.analyticsManager.viewerTracker.getTopUsers(5);
                    await twitchBot.sendMessage(channel, `Top 5 Most Active Viewers: ${topUsers.join(' | ')}`);
                    logger.info('SpecialCommandHandlers', 'Top stats command executed', {
                        channel,
                        topUsers: topUsers.length,
                        requestedBy: context.username
                    });
                    return;
                }

                const topUsers = await twitchBot.viewerManager.getTopUsers(5);
                await twitchBot.sendMessage(channel, `Top 5 Most Active Viewers: ${topUsers.join(' | ')}`);
                logger.info('SpecialCommandHandlers', 'Top stats command executed', {
                    channel,
                    topUsers: topUsers.length,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error in topStats', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'An error occurred while fetching top stats.');
            }
        },

        async toggleSongs(twitchBot, channel, context, args, command) {
            try {
                if (!context.mod && !context.badges?.broadcaster) return;

                const channelId = await twitchBot.users.getUserByName(channel);
                if (!channelId) {
                    logger.error('SpecialCommandHandlers', 'Channel not found for toggleSongs', { channel });
                    return;
                }

                // Get all channel rewards
                const rewards = await twitchBot.channelPoints.getCustomRewards(channelId.id);
                const songReward = rewards.find(reward => reward.title.toLowerCase() === 'song request');
                const skipQueueReward = rewards.find(reward => reward.title.toLowerCase() === 'skip song queue');

                if (!songReward || !skipQueueReward) {
                    await twitchBot.sendMessage(channel, 'Could not find one or both song-related rewards!');
                    logger.warn('SpecialCommandHandlers', 'Song rewards not found', {
                        channel,
                        hasSongReward: !!songReward,
                        hasSkipReward: !!skipQueueReward
                    });
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
                logger.info('SpecialCommandHandlers', 'Song requests toggled', {
                    channel,
                    enabled: enable,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error toggling songs', { error: error.message, stack: error.stack, channel, command });
                await twitchBot.sendMessage(channel, `Failed to ${command === '!songson' ? 'enable' : 'disable'} song requests: ${error.message}`);
            }
        },

        async nextSong(twitchBot, channel) {
            try {
                const pendingTracks = await spotifyManager.queueManager.getPendingTracks();

                if (pendingTracks.length === 0) {
                    await twitchBot.sendMessage(channel, 'There are no songs in the queue.');
                    logger.debug('SpecialCommandHandlers', 'Next song requested - queue empty', { channel });
                    return;
                }

                const nextTrack = pendingTracks[0];
                await twitchBot.sendMessage(channel, `Next song in queue: ${nextTrack.name} by ${nextTrack.artist} (requested by ${nextTrack.requestedBy})`);
                logger.info('SpecialCommandHandlers', 'Next song command executed', {
                    channel,
                    trackName: nextTrack.name,
                    artistName: nextTrack.artist,
                    requestedBy: nextTrack.requestedBy
                });
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error fetching next song', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Unable to fetch next song information.');
            }
        },

        async queueInfo(twitchBot, channel, context, args) {
            try {
                const pendingTracks = await spotifyManager.queueManager.getPendingTracks();

                if (pendingTracks.length === 0) {
                    await twitchBot.sendMessage(channel, 'The queue is currently empty.');
                    logger.debug('SpecialCommandHandlers', 'Queue info requested - queue empty', { channel });
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
                logger.info('SpecialCommandHandlers', 'Queue info command executed', {
                    channel,
                    queueLength: pendingTracks.length,
                    targetUser: requestedUser,
                    userSongCount: userPositions.length,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error fetching queue information', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Unable to fetch queue information.');
            }
        },

        async skipSong(twitchBot, channel, context) {
            if (!context.mod && !context.badges?.broadcaster) return;
            try {
                await spotifyManager.ensureTokenValid();
                const state = await spotifyManager.getPlaybackState();

                if (state === 'CLOSED') {
                    await twitchBot.sendMessage(channel, 'Spotify is not currently active.');
                    logger.debug('SpecialCommandHandlers', 'Skip song failed - Spotify not active', { channel });
                    return;
                }

                // Check if there's a song in the queue before skipping
                const pendingTracks = await spotifyManager.queueManager.getPendingTracks();
                if (pendingTracks.length > 0) {
                    // Add next song to Spotify queue before skipping
                    const nextTrack = pendingTracks[0];
                    await spotifyManager.spotifyApi.addToQueue(nextTrack.uri);
                    spotifyManager.queueManager.removeFirstTrack();
                    logger.debug('SpecialCommandHandlers', 'Added next track to queue before skip', {
                        trackName: nextTrack.name,
                        artist: nextTrack.artist
                    });
                }

                // Skip the current song
                await spotifyManager.spotifyApi.skipToNext();
                await twitchBot.sendMessage(channel, 'Skipped to next song!');
                logger.info('SpecialCommandHandlers', 'Song skipped', {
                    channel,
                    requestedBy: context.username
                });

            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error skipping song', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Unable to skip song. Make sure Spotify is active.');
            }
        },

        async emoteAdd(twitchBot, channel, context, args) {
            if (!context.mod && !context.badges?.broadcaster) return;

            if (args.length < 2) {
                await twitchBot.sendMessage(channel, 'Usage: !emoteadd <trigger> <response>');
                return;
            }

            const trigger = args[0].toLowerCase();
            const response = args.slice(1).join(' ');

            try {
                const success = await twitchBot.emoteManager.addEmote(trigger, response);
                if (success) {
                    await twitchBot.sendMessage(channel, `Emote "${trigger}" added successfully!`);
                    logger.info('SpecialCommandHandlers', 'Emote added', {
                        channel,
                        trigger,
                        requestedBy: context.username
                    });
                } else {
                    await twitchBot.sendMessage(channel, `Emote "${trigger}" already exists.`);
                    logger.debug('SpecialCommandHandlers', 'Emote already exists', {
                        channel,
                        trigger
                    });
                }
            } catch (error) {
                logger.error('SpecialCommandHandlers', 'Error adding emote', {
                    error: error.message,
                    stack: error.stack,
                    channel,
                    trigger
                });
                await twitchBot.sendMessage(channel, 'Error adding emote.');
            }
        }
    };
}

module.exports = specialCommandHandlers;
