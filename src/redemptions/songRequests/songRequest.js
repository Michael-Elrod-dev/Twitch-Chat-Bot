async function handleSongRequest(event, client, spotifyManager, apiClient) {
    try {
        console.log('* Song Request Redemption Detected:');
        console.log(`  User: ${event.userDisplayName}`);
        console.log(`  Song Request: ${event.input || 'No input provided'}`);

        const input = event.input.trim();
        
        if (!input) {
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
                console.error('Error refunding points:', refundError);
                throw refundError;
            }
            return;
        }

        if (!input.includes('spotify.com/track/')) {
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
                console.error('Error refunding points:', refundError);
                throw refundError;
            }
            return;
        }

        const trackId = input.split('track/')[1].split('?')[0];
        const trackUri = `spotify:track:${trackId}`;

        try {
            // Get track info first
            const trackInfo = await spotifyManager.spotifyApi.getTrack(trackId);
            const trackName = trackInfo.body.name;
            const artistName = trackInfo.body.artists[0].name;

            // Add to history playlist first
            let wasAddedToPlaylist = false;
            try {
                wasAddedToPlaylist = await spotifyManager.addToRequestsPlaylist(trackUri);
            } catch (playlistError) {
                console.error('Error adding to history playlist:', playlistError);
            }

            // Try to add to queue (or pending queue)
            try {
                await spotifyManager.addToQueue(trackUri);
            } catch (queueError) {
                if (queueError.body?.error?.reason === 'NO_ACTIVE_DEVICE') {
                    // Add to pending queue
                    spotifyManager.queueManager.addToPendingQueue({
                        uri: trackUri,
                        name: trackName,
                        artist: artistName,
                        requestedBy: event.userDisplayName
                    });
                } else {
                    throw queueError;
                }
            }

            // Mark redemption as fulfilled
            await apiClient.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'FULFILLED'
            );

            // Send message to chat - same format regardless of Spotify status
            let message = `@${event.userDisplayName} Successfully added "${trackName}" by ${artistName} to the queue!`;
            if (wasAddedToPlaylist) {
                message += ' This song is new and has been added to the Chat Playlist: https://open.spotify.com/playlist/2NAkywBRNBcYN0Q1gob1bF?si=6e4c734c87244bd0';
            }
            await client.say(`#${event.broadcasterDisplayName}`, message);

        } catch (error) {
            console.error('Error processing Spotify track:', error);
            try {
                await apiClient.channelPoints.updateRedemptionStatusByIds(
                    event.broadcasterId,
                    event.rewardId,
                    [event.id],
                    'CANCELED'
                );
                
                await client.say(`#${event.broadcasterDisplayName}`, 
                    `@${event.userDisplayName} Sorry, I couldn't process your request. Your points have been refunded.`);
            } catch (refundError) {
                console.error('Error refunding points:', refundError);
            }
        }

    } catch (error) {
        console.error('Error in song request handler:', error);
        try {
            await apiClient.channelPoints.updateRedemptionStatusByIds(
                event.broadcasterId,
                event.rewardId,
                [event.id],
                'CANCELED'
            );
            
            await client.say(`#${event.broadcasterDisplayName}`, 
                `@${event.userDisplayName} Sorry, there was an error processing your request. Your points have been refunded.`);
        } catch (refundError) {
            console.error('Error refunding points:', refundError);
        }
    }
}

module.exports = handleSongRequest;