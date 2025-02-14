# AlmostHadAI Twitch Bot

Needs updating

## Technical Architecture

### Directory Structure
```
src/
  ├── chats/       # Chat monitoring
  ├── commands/    # Command management
  ├── data/        # Persistent storage
  ├── redemptions/ # Channel point features
     ├── quotes/     # Quotes management
     └── songs       # Song request management
  ├── tokens/      # Token management
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
