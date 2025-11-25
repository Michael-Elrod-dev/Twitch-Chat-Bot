// src/commands/handlers/spotify.js

const logger = require('../../logger/logger');

function spotifyHandlers(dependencies) {
    const { spotifyManager, songToggleService } = dependencies;

    return {
        async currentSong(twitchBot, channel) {
            try {
                await spotifyManager.ensureTokenValid();
                const currentTrack = await spotifyManager.spotifyApi.getMyCurrentPlayingTrack();

                if (currentTrack.body && currentTrack.body.item) {
                    const trackName = currentTrack.body.item.name;
                    const artistName = currentTrack.body.item.artists[0].name;
                    await twitchBot.sendMessage(channel, `Currently playing: ${trackName} by ${artistName}`);
                    logger.info('SpotifyHandlers', 'Current song command executed', {
                        channel,
                        trackName,
                        artistName
                    });
                } else {
                    await twitchBot.sendMessage(channel, 'No song is currently playing in Spotify.');
                    logger.debug('SpotifyHandlers', 'No song currently playing', { channel });
                }
            } catch (error) {
                logger.error('SpotifyHandlers', 'Error fetching current song', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Unable to fetch current song information.');
            }
        },

        async lastSong(twitchBot, channel) {
            try {
                if (spotifyManager.previousTrack) {
                    const { name, artist } = spotifyManager.previousTrack;
                    await twitchBot.sendMessage(channel, `Last played song: ${name} by ${artist}`);
                    logger.info('SpotifyHandlers', 'Last song command executed', {
                        channel,
                        trackName: name,
                        artistName: artist
                    });
                } else {
                    await twitchBot.sendMessage(channel, 'No previous song information available yet.');
                    logger.debug('SpotifyHandlers', 'No previous song available', { channel });
                }
            } catch (error) {
                logger.error('SpotifyHandlers', 'Error fetching last song', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Unable to fetch last song information.');
            }
        },

        async nextSong(twitchBot, channel) {
            try {
                const pendingTracks = await spotifyManager.queueManager.getPendingTracks();

                if (pendingTracks.length === 0) {
                    await twitchBot.sendMessage(channel, 'There are no songs in the queue.');
                    logger.debug('SpotifyHandlers', 'Next song requested - queue empty', { channel });
                    return;
                }

                const nextTrack = pendingTracks[0];
                await twitchBot.sendMessage(channel, `Next song in queue: ${nextTrack.name} by ${nextTrack.artist} (requested by ${nextTrack.requestedBy})`);
                logger.info('SpotifyHandlers', 'Next song command executed', {
                    channel,
                    trackName: nextTrack.name,
                    artistName: nextTrack.artist,
                    requestedBy: nextTrack.requestedBy
                });
            } catch (error) {
                logger.error('SpotifyHandlers', 'Error fetching next song', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Unable to fetch next song information.');
            }
        },

        async queueInfo(twitchBot, channel, context, args) {
            try {
                const pendingTracks = await spotifyManager.queueManager.getPendingTracks();

                if (pendingTracks.length === 0) {
                    await twitchBot.sendMessage(channel, 'The queue is currently empty.');
                    logger.debug('SpotifyHandlers', 'Queue info requested - queue empty', { channel });
                    return;
                }

                const requestedUser = args[0] ? args[0].replace('@', '').toLowerCase() : context.username.toLowerCase();

                const userPositions = pendingTracks
                    .map((track, index) => ({ position: index + 1, requestedBy: track.requestedBy }))
                    .filter(track => track.requestedBy.toLowerCase() === requestedUser)
                    .map(track => track.position);

                let response = `Queue length: ${pendingTracks.length} song${pendingTracks.length !== 1 ? 's' : ''}`;

                if (userPositions.length > 0) {
                    response += ` | ${requestedUser}'s songs are in position${userPositions.length !== 1 ? 's' : ''}: ${userPositions.join(', ')}`;
                } else {
                    response += ` | ${requestedUser} has no songs in queue`;
                }

                await twitchBot.sendMessage(channel, response);
                logger.info('SpotifyHandlers', 'Queue info command executed', {
                    channel,
                    queueLength: pendingTracks.length,
                    targetUser: requestedUser,
                    userSongCount: userPositions.length,
                    requestedBy: context.username
                });
            } catch (error) {
                logger.error('SpotifyHandlers', 'Error fetching queue information', { error: error.message, stack: error.stack, channel });
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
                    logger.debug('SpotifyHandlers', 'Skip song failed - Spotify not active', { channel });
                    return;
                }

                const pendingTracks = await spotifyManager.queueManager.getPendingTracks();
                if (pendingTracks.length > 0) {
                    const nextTrack = pendingTracks[0];
                    await spotifyManager.spotifyApi.addToQueue(nextTrack.uri);
                    await spotifyManager.queueManager.removeFirstTrack();
                    logger.debug('SpotifyHandlers', 'Added next track to queue before skip', {
                        trackName: nextTrack.name,
                        artist: nextTrack.artist
                    });
                }

                await spotifyManager.spotifyApi.skipToNext();
                await twitchBot.sendMessage(channel, 'Skipped to next song!');
                logger.info('SpotifyHandlers', 'Song skipped', {
                    channel,
                    requestedBy: context.username
                });

            } catch (error) {
                logger.error('SpotifyHandlers', 'Error skipping song', { error: error.message, stack: error.stack, channel });
                await twitchBot.sendMessage(channel, 'Unable to skip song. Make sure Spotify is active.');
            }
        },

        async toggleSongs(twitchBot, channel, context, args) {
            try {
                if (!context.mod && !context.badges?.broadcaster) return;

                if (!args[0] || (args[0].toLowerCase() !== 'on' && args[0].toLowerCase() !== 'off')) {
                    await twitchBot.sendMessage(channel, 'Usage: !songs <on|off>');
                    return;
                }

                const enable = args[0].toLowerCase() === 'on';
                const result = await songToggleService.toggleSongs(channel, enable);

                await twitchBot.sendMessage(channel, result.message);

                if (result.success && !result.alreadyInState) {
                    logger.info('SpotifyHandlers', 'Song requests toggled via chat command', {
                        channel,
                        enabled: result.enabled,
                        requestedBy: context.username
                    });
                }
            } catch (error) {
                logger.error('SpotifyHandlers', 'Error in toggleSongs handler', {
                    error: error.message,
                    stack: error.stack,
                    channel
                });
                await twitchBot.sendMessage(channel, `Failed to ${args[0]?.toLowerCase() === 'on' ? 'enable' : 'disable'} song requests: ${error.message}`);
            }
        }
    };
}

module.exports = spotifyHandlers;
