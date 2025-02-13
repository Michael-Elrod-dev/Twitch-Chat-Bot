// youtubeManager.js
const { google } = require('googleapis');

class YouTubeManager {
    constructor(tokenManager) {
        this.tokenManager = tokenManager;
        this.youtube = google.youtube('v3');
        this.queue = [];
        this.isPlaying = false;
        this.currentTrack = null;
        
        // Initialize YouTube API client
        this.init();
    }

    async init() {
        try {
            // Initialize with your YouTube API credentials
            this.auth = new google.auth.OAuth2(
                this.tokenManager.tokens.youtubeClientId,
                this.tokenManager.tokens.youtubeClientSecret,
                'http://localhost:3000/youtube/callback'
            );

            if (this.tokenManager.tokens.youtubeAccessToken) {
                this.auth.setCredentials({
                    access_token: this.tokenManager.tokens.youtubeAccessToken,
                    refresh_token: this.tokenManager.tokens.youtubeRefreshToken
                });
            }
        } catch (error) {
            console.error('Error initializing YouTube manager:', error);
        }
    }

    extractVideoId(url) {
        let videoId = '';
        
        if (url.includes('youtube.com/watch?v=')) {
            videoId = url.split('v=')[1];
        } else if (url.includes('youtu.be/')) {
            videoId = url.split('youtu.be/')[1];
        }
        
        // Remove any additional parameters
        const ampersandPosition = videoId.indexOf('&');
        if (ampersandPosition !== -1) {
            videoId = videoId.substring(0, ampersandPosition);
        }
        
        return videoId;
    }

    async getVideoInfo(videoId) {
        try {
            const response = await this.youtube.videos.list({
                auth: this.auth,
                part: 'snippet',
                id: videoId
            });

            if (response.data.items.length === 0) {
                throw new Error('Video not found');
            }

            return {
                id: videoId,
                title: response.data.items[0].snippet.title,
                channelTitle: response.data.items[0].snippet.channelTitle
            };
        } catch (error) {
            console.error('Error getting video info:', error);
            throw error;
        }
    }

    async addToQueue(videoId) {
        try {
            const videoInfo = await this.getVideoInfo(videoId);
            this.queue.push(videoInfo);
            
            if (!this.isPlaying) {
                this.startPlaying();
            }
            
            return true;
        } catch (error) {
            console.error('Error adding to queue:', error);
            throw error;
        }
    }

    async startPlaying() {
        // Implement your YouTube playback logic here
        // This will depend on how you want to handle playback
        // (e.g., through a browser source in OBS, or other method)
    }

    // Add more methods as needed for your specific implementation
}

module.exports = YouTubeManager;