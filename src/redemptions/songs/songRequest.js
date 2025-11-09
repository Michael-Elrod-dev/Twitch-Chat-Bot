// src/redemptions/songs/songRequest.js

const logger = require('../../logger/logger');

async function handleSongRequest(event, twitchBot, spotifyManager) {
    try {
        const input = event.input.trim();
        const isPriorityRequest = event.rewardTitle.toLowerCase().includes('skip song queue');

        if (!input) {
            logger.info('SongRequest', 'Redemption cancelled: No input provided', {
                userId: event.userId,
                userDisplayName: event.userDisplayName,
                rewardTitle: event.rewardTitle
            });
            try {
                await twitchBot.redemptionManager.updateRedemptionStatus(
                    event.broadcasterId,
                    event.rewardId,
                    [event.id],
                    'CANCELED'
                );

                await twitchBot.sendMessage(event.broadcasterDisplayName,
                    `@${event.userDisplayName} Please provide a Spotify song link! Your points have been refunded.`);
            } catch (refundError) {
                logger.error('SongRequest', 'Error refunding points', {
                    error: refundError.message,
                    stack: refundError.stack,
                    userId: event.userId,
                    userDisplayName: event.userDisplayName
                });
                throw refundError;
            }
            return;
        }

        if (!input.includes('spotify.com/track/')) {
            logger.info('SongRequest', 'Redemption cancelled: Invalid Spotify link', {
                userId: event.userId,
                userDisplayName: event.userDisplayName,
                input: input
            });
            try {
                await twitchBot.redemptionManager.updateRedemptionStatus(
                    event.broadcasterId,
                    event.rewardId,
                    [event.id],
                    'CANCELED'
                );

                await twitchBot.sendMessage(event.broadcasterDisplayName,
                    `@${event.userDisplayName} Please provide a valid Spotify song link! Your points have been refunded.`);
            } catch (refundError) {
                logger.error('SongRequest', 'Error refunding points', {
                    error: refundError.message,
                    stack: refundError.stack,
                    userId: event.userId,
                    userDisplayName: event.userDisplayName
                });
                throw refundError;
            }
            return;
        }

        const trackId = input.split('track/')[1].split('?')[0];
        const trackUri = `spotify:track:${trackId}`;

        try {
            const trackInfo = await spotifyManager.spotifyApi.getTrack(trackId);
            const trackName = trackInfo.body.name;
            const artistName = trackInfo.body.artists[0].name;

            let wasAddedToPlaylist = false;
            try {
                wasAddedToPlaylist = await spotifyManager.addToRequestsPlaylist(trackUri);
            } catch (playlistError) {
                logger.error('SongRequest', 'Error adding to history playlist', {
                    error: playlistError.message,
                    stack: playlistError.stack,
                    trackUri,
                    trackName,
                    artistName
                });
            }

            if (isPriorityRequest) {
                await spotifyManager.queueManager.addToPriorityQueue({
                    uri: trackUri,
                    name: trackName,
                    artist: artistName,
                    requestedBy: event.userDisplayName
                });
            } else {
                await spotifyManager.queueManager.addToPendingQueue({
                    uri: trackUri,
                    name: trackName,
                    artist: artistName,
                    requestedBy: event.userDisplayName
                });
            }
            logger.info('SongRequest', 'Song successfully added to queue', {
                trackName,
                artistName,
                requestedBy: event.userDisplayName,
                userId: event.userId,
                isPriorityRequest,
                wasAddedToPlaylist
            });

            await twitchBot.redemptionManager.updateRedemptionStatus(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'FULFILLED'
            );
            logger.debug('SongRequest', 'Redemption marked as fulfilled', {
                redemptionId: event.id,
                trackName
            });

            let message = `@${event.userDisplayName} Successfully added "${trackName}" by ${artistName} to the ${isPriorityRequest ? 'priority ' : ''}queue!`;
            if (wasAddedToPlaylist) {
                message += ' This song is new and has been added to the Chat Playlist: https://open.spotify.com/playlist/2NAkywBRNBcYN0Q1gob1bF?si=6e4c734c87244bd0';
            }
            await twitchBot.sendMessage(event.broadcasterDisplayName, message);
            logger.debug('SongRequest', 'Success message sent to chat', {
                trackName,
                userDisplayName: event.userDisplayName
            });

        } catch (error) {
            logger.error('SongRequest', 'Error processing Spotify track', {
                error: error.message,
                stack: error.stack,
                trackUri: trackUri,
                userId: event.userId,
                userDisplayName: event.userDisplayName
            });
            try {
                await twitchBot.redemptionManager.updateRedemptionStatus(
                    event.broadcasterId,
                    event.rewardId,
                    [event.id],
                    'CANCELED'
                );

                await twitchBot.sendMessage(event.broadcasterDisplayName,
                    `@${event.userDisplayName} Sorry, I couldn't process your request. Your points have been refunded.`);
                logger.info('SongRequest', 'Points refunded successfully', {
                    userId: event.userId,
                    userDisplayName: event.userDisplayName
                });
            } catch (refundError) {
                logger.error('SongRequest', 'Critical: Error refunding points', {
                    error: refundError.message,
                    stack: refundError.stack,
                    userId: event.userId,
                    userDisplayName: event.userDisplayName
                });
            }
        }

    } catch (error) {
        logger.error('SongRequest', 'Critical: Fatal error in song request handler', {
            error: error.message,
            stack: error.stack,
            userId: event.userId,
            userDisplayName: event.userDisplayName,
            rewardId: event.rewardId,
            input: event.input
        });
        try {
            logger.info('SongRequest', 'Attempting to refund points after fatal error', {
                userId: event.userId,
                userDisplayName: event.userDisplayName
            });
            await twitchBot.redemptionManager.updateRedemptionStatus(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );

            await twitchBot.sendMessage(event.broadcasterDisplayName,
                `@${event.userDisplayName} Sorry, there was an error processing your request. Your points have been refunded.`);
            logger.info('SongRequest', 'Points refunded successfully after fatal error', {
                userId: event.userId,
                userDisplayName: event.userDisplayName
            });
        } catch (refundError) {
            logger.error('SongRequest', 'Critical: Error refunding points after fatal error', {
                error: refundError.message,
                stack: refundError.stack,
                userId: event.userId,
                userDisplayName: event.userDisplayName
            });
        }
    }
}

module.exports = handleSongRequest;
