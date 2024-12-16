# AlmostHadAI Twitch Bot

[Previous content remains the same until Technical Architecture]

## Technical Architecture

### Directory Structure
```
ALMOSTHADAI/
├── files/           # Configuration and tokens
├── src/
    ├── commands/    # Command handling system
    ├── data/        # Persistent storage
    ├── redemptions/ # Channel point features
    ├── utils/       # Helper utilities
    └── bot.js       # Main application
```

### Key Components
- `bot.js` - Core application with Twitch integration and event handling
  - Manages token refresh and authentication
  - Handles EventSub WebSocket connections
  - Coordinates between Twitch chat and channel points
  - Initializes all subsystems (Spotify, commands, redemptions)
- `spotifyManager.js` - Handles Spotify authentication and playback control
- `redemptionManager.js` - Manages channel point redemptions
- `commandManager.js` - Command processing and storage
- `tokenManager.js` - Authentication token management and refresh logic
- `quoteManager.js` - Manages saving and retrieving chat quotes
- `handleQuote.js` - Processes channel point quote redemptions

### Authentication System
The bot implements a robust token management system:
- Automatic token refresh on startup
- Continuous token validity monitoring
- Separate handling for bot and broadcaster tokens
- Graceful error recovery for expired tokens
- Token persistence between sessions

### Token Refresh Flow
1. Initial token validation on startup
2. Automatic refresh of expired tokens
3. Persistent storage of new tokens
4. Independent refresh cycles for:
   - Bot chat tokens
   - Broadcaster tokens
   - Spotify access tokens

### Error Recovery
The bot includes several error recovery mechanisms:
- Automatic reconnection on disconnection
- Token refresh on authentication failures
- Pending queue for Spotify offline states
- Graceful handling of API rate limits
- Event subscription recovery

### State Management
- Spotify playback state monitoring
- Channel point redemption state tracking
- Command state persistence
- Token refresh state management
- Connection state monitoring
- Quote storage and retrieval system

[Rest of previous content remains the same]

## Setup and Configuration

### Token Configuration
Create a `tokens.json` file in the `files` directory with:
```json
{
    "clientId": "your_twitch_client_id",
    "clientSecret": "your_twitch_client_secret",
    "channelId": "your_channel_id",
    "botAccessToken": "your_bot_access_token",
    "botRefreshToken": "your_bot_refresh_token",
    "broadcasterAccessToken": "your_broadcaster_access_token",
    "broadcasterRefreshToken": "your_broadcaster_refresh_token",
    "spotifyClientId": "your_spotify_client_id",
    "spotifyClientSecret": "your_spotify_client_secret"
}
```

### Required Scopes
- Twitch Bot: `chat:edit`, `chat:read`
- Twitch Broadcaster: `channel:read:redemptions`, `channel:manage:redemptions`, `channel:manage:rewards`
- Spotify: Various playback and playlist management scopes

## Implementation Notes
- Token refresh is handled automatically by the `RefreshingAuthProvider`
- Spotify connection state is monitored every 10 seconds
- Failed song requests are stored in a persistent pending queue
- Commands are saved to disk automatically when modified
- Event listeners are properly bound to maintain context