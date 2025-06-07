// src/redemptions/songs/songRequest.js
async function handleSongRequest(event, twitchBot, spotifyManager) {
    try {
        const input = event.input.trim();
        const isPriorityRequest = event.rewardTitle.toLowerCase().includes('skip song queue');
        
        if (!input) {
            console.log('* Redemption cancelled: No input provided');
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
                console.error('* Error refunding points:', refundError);
                throw refundError;
            }
            return;
        }

        if (!input.includes('spotify.com/track/')) {
            console.log('* Redemption cancelled: Invalid Spotify link');
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
                console.error('* Error refunding points:', refundError);
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
                console.error('* Error adding to history playlist:', playlistError);
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
            console.log('* Successfully added to queue');

            await twitchBot.redemptionManager.updateRedemptionStatus(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'FULFILLED'
            );
            console.log('* Redemption marked as fulfilled');

            let message = `@${event.userDisplayName} Successfully added "${trackName}" by ${artistName} to the ${isPriorityRequest ? 'priority ' : ''}queue!`;
            if (wasAddedToPlaylist) {
                message += ' This song is new and has been added to the Chat Playlist: https://open.spotify.com/playlist/2NAkywBRNBcYN0Q1gob1bF?si=6e4c734c87244bd0';
            }
            await twitchBot.sendMessage(event.broadcasterDisplayName, message);
            console.log('* Success message sent to chat');

        } catch (error) {
            console.error('* Error processing Spotify track:', {
                error: error.message,
                stack: error.stack,
                trackUri: trackUri
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
                console.log('* Points refunded successfully');
            } catch (refundError) {
                console.error('* Critical: Error refunding points:', {
                    error: refundError.message,
                    stack: refundError.stack
                });
            }
        }

    } catch (error) {
        console.error('* Critical: Fatal error in song request handler:', {
            error: error.message,
            stack: error.stack,
            eventData: {
                user: event.userDisplayName,
                rewardId: event.rewardId,
                input: event.input
            }
        });
        try {
            console.log('* Attempting to refund points after fatal error...');
            await twitchBot.redemptionManager.updateRedemptionStatus(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await twitchBot.sendMessage(event.broadcasterDisplayName,
                `@${event.userDisplayName} Sorry, there was an error processing your request. Your points have been refunded.`);
            console.log('* Points refunded successfully after fatal error');
        } catch (refundError) {
            console.error('* Critical: Error refunding points after fatal error:', {
                error: refundError.message,
                stack: refundError.stack
            });
        }
    }
}

module.exports = handleSongRequest;