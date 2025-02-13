async function handleSongRequest(event, client, spotifyManager, apiClient) {
    console.log('* Song Request Redemption Received:', {
        timestamp: new Date().toISOString(),
        user: event.userDisplayName,
        rewardTitle: event.rewardTitle,
        input: event.input || 'No input provided'
    });

    try {
        console.log(`* User: ${event.userDisplayName}`);
        console.log(`* Song Request: ${event.input || 'No input provided'}`);

        const input = event.input.trim();
        
        if (!input) {
            console.log('* Redemption cancelled: No input provided');
            try {
                await apiClient.channelPoints.updateRedemptionStatusByIds(
                    event.broadcasterId,
                    event.rewardId,
                    [event.id],
                    'CANCELED'
                );
                
                await client.say(`#${event.broadcasterDisplayName}`, 
                    `@${event.userDisplayName} Please provide a Spotify song link! Your points have been refunded.`);
            } catch (refundError) {
                console.error('* Error refunding points:', refundError);
                throw refundError;
            }
            return;
        }

        // Temporary YouTube link handling
        if (input.includes('youtube.com/watch?v=') || input.includes('youtu.be/')) {
            console.log('* YouTube link detected - feature not yet implemented');
            try {
                await apiClient.channelPoints.updateRedemptionStatusByIds(
                    event.broadcasterId,
                    event.rewardId,
                    [event.id],
                    'CANCELED'
                );
                
                await client.say(`#${event.broadcasterDisplayName}`, 
                    `@${event.userDisplayName} YouTube links are not supported yet - please use Spotify links only! Your points have been refunded.`);
                return;
            } catch (refundError) {
                console.error('* Error refunding points:', refundError);
                throw refundError;
            }
        }

        if (!input.includes('spotify.com/track/')) {
            console.log('* Redemption cancelled: Invalid Spotify link');
            try {
                await apiClient.channelPoints.updateRedemptionStatusByIds(
                    event.broadcasterId,
                    event.rewardId,
                    [event.id],
                    'CANCELED'
                );
                
                await client.say(`#${event.broadcasterDisplayName}`, 
                    `@${event.userDisplayName} Please provide a valid Spotify song link! Your points have been refunded.`);
            } catch (refundError) {
                console.error('* Error refunding points:', refundError);
                throw refundError;
            }
            return;
        }

        const trackId = input.split('track/')[1].split('?')[0];
        const trackUri = `spotify:track:${trackId}`;
        console.log('* Extracted track URI:', trackUri);

        try {
            // Get track info first
            console.log('* Fetching track info from Spotify...');
            const trackInfo = await spotifyManager.spotifyApi.getTrack(trackId);
            const trackName = trackInfo.body.name;
            const artistName = trackInfo.body.artists[0].name;
            console.log('* Track info retrieved:', { trackName, artistName });

            // Add to history playlist first
            let wasAddedToPlaylist = false;
            try {
                console.log('* Attempting to add to history playlist...');
                wasAddedToPlaylist = await spotifyManager.addToRequestsPlaylist(trackUri);
                console.log('* Added to history playlist:', wasAddedToPlaylist);
            } catch (playlistError) {
                console.error('* Error adding to history playlist:', playlistError);
            }

            // Try to add to queue (or pending queue)
            try {
                console.log('* Attempting to add to Spotify queue...');
                await spotifyManager.addToQueue(trackUri);
                console.log('* Successfully added to Spotify queue');
            } catch (queueError) {
                console.log('* Queue error:', queueError.body?.error?.reason);
                if (queueError.body?.error?.reason === 'NO_ACTIVE_DEVICE') {
                    console.log('* No active device, adding to pending queue');
                    // Add to pending queue
                    spotifyManager.queueManager.addToPendingQueue({
                        uri: trackUri,
                        name: trackName,
                        artist: artistName,
                        requestedBy: event.userDisplayName
                    });
                    console.log('* Added to pending queue successfully');
                } else {
                    throw queueError;
                }
            }

            // Mark redemption as fulfilled
            console.log('* Marking redemption as fulfilled...');
            await apiClient.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'FULFILLED'
            );
            console.log('* Redemption marked as fulfilled');

            // Send message to chat
            let message = `@${event.userDisplayName} Successfully added "${trackName}" by ${artistName} to the queue!`;
            if (wasAddedToPlaylist) {
                message += ' This song is new and has been added to the Chat Playlist: https://open.spotify.com/playlist/2NAkywBRNBcYN0Q1gob1bF?si=6e4c734c87244bd0';
            }
            await client.say(`#${event.broadcasterDisplayName}`, message);
            console.log('* Success message sent to chat');

        } catch (error) {
            console.error('* Error processing Spotify track:', {
                error: error.message,
                stack: error.stack,
                trackUri: trackUri
            });
            try {
                console.log('* Attempting to refund points due to error...');
                await apiClient.channelPoints.updateRedemptionStatusByIds(
                    event.broadcasterId,
                    event.rewardId,
                    [event.id],
                    'CANCELED'
                );
                
                await client.say(`#${event.broadcasterDisplayName}`, 
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
            await apiClient.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await client.say(`#${event.broadcasterDisplayName}`, 
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