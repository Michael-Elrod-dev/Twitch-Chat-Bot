# AlmostHadAI Twitch Bot

A Twitch chat bot featuring Spotify queue automation, channel point redemptions, dynamic commands, and database-driven analytics

## Directory Structure

```
src/
├── analytics/                 # Stream and chat analytics
│   ├── viewers/               # Viewer tracking and statistics
│   │   └── viewerTracker.js   # Viewer interaction tracking
│   └── analyticsManager.js    # Central analytics coordination
├── commands/                  # Command handling
│   ├── commandManager.js      # Custom command management
│   └── specialCommandHandlers.js # Built-in command implementations
├── config/                    # Configuration
│   └── config.js              # App-wide configuration
├── database/                  # Database management
│   ├── dbManager.js           # Database connection handling
│   └── schema.sql             # Database schema
├── emotes/                    # Emote response system
│   └── emoteManager.js        # Emote trigger and response handling
├── messages/                  # Message handling
│   ├── chatMessageHandler.js  # Chat message processing
│   ├── messageSender.js       # Message sending to Twitch
│   └── redemptionHandler.js   # Channel point redemption processing
├── redemptions/               # Channel point features
│   ├── quotes/                # Quote system
│   │   ├── handleQuote.js     # Quote redemption handler
│   │   └── quoteManager.js    # Quote storage and retrieval
│   ├── songs/                 # Song request system
│   │   ├── queueManager.js    # Song queue management
│   │   ├── songRequest.js     # Song request handling
│   │   └── spotifyManager.js  # Spotify API integration
│   └── redemptionManager.js   # Channel point redemption routing
├── tokens/                    # API authentication
│   ├── tokenManager.js        # Token refresh and storage
│   └── twitchAPI.js           # Twitch API wrapper
├── websocket/                 # Real-time communication
│   ├── eventHandler.js        # EventSub event handling
│   ├── subscriptionManager.js # EventSub subscription management
│   └── webSocketManager.js    # WebSocket connection handling
└── bot.js                     # Main application entry point
```

## Key Components

### Core Bot (`bot.js`)
- Initializes all subsystems and manages their lifecycle
- Coordinates between components via dependency injection
- Establishes event subscriptions and message routing
- Handles stream start/end detection and cleanup
- Manages database connections and SQL-based data persistence
- Tracks current stream sessions and viewer analytics

### Database Layer (`database/`)
- **dbManager.js**: Handles MySQL database connections and query execution
- **schema.sql**: Defines database structure for analytics, commands, emotes, and user data

### Authentication & API (`tokens/`)
- **tokenManager.js**: Manages OAuth tokens for Twitch and Spotify with automatic refreshing and database storage
- **twitchAPI.js**: Provides methods for interacting with Twitch API endpoints including user lookup, stream info, and channel point management

### Event Handling (`websocket/`)
- **webSocketManager.js**: Maintains WebSocket connection to Twitch EventSub with automatic reconnection
- **subscriptionManager.js**: Sets up and manages event subscriptions for chat, channel points, and stream offline events
- **eventHandler.js**: ~~Routes incoming events to appropriate handlers~~ Currently placeholder for future event handling logic

### Message Processing (`messages/`)
- **chatMessageHandler.js**: Processes incoming chat messages and routes to commands with badge detection and emote responses
- **messageSender.js**: Handles sending messages to Twitch chat with token validation
- **redemptionHandler.js**: Processes channel point redemptions and tracks them in analytics

### Commands (`commands/`)
- **commandManager.js**: Manages custom commands with database storage, caching, and permission handling
- **specialCommandHandlers.js**: Implements built-in commands with complex functionality including stats, quotes, Spotify controls, and moderation tools

### Emote System (`emotes/`)
- **emoteManager.js**: Handles automatic emote responses with database storage and caching

### Channel Point Features (`redemptions/`)
- **redemptionManager.js**: Routes redemptions to appropriate handlers and manages redemption status updates
- **quotes/**: Quote saving and retrieval system with database persistence
- **songs/**: Spotify song request and queue management with database-backed queue

### Spotify Integration (`redemptions/songs/`)
- **spotifyManager.js**: Authenticates with Spotify and manages playback with automatic queue monitoring and playlist integration
- **queueManager.js**: Manages pending song requests with database persistence and priority queue support
- **songRequest.js**: Processes song request redemptions with validation and error handling

### Analytics & Viewer Tracking (`analytics/`)
- **analyticsManager.js**: Coordinates stream and chat data collection with real-time tracking
- **viewers/viewerTracker.js**: Tracks viewer participation statistics, message counts, and session management

## Features

- **Custom Commands**: Create, edit, and manage chat commands with database persistence and permission levels
- **Song Requests**: Channel point integration with Spotify with automatic queue management and playlist archiving**
- **Quote System**: Save and retrieve memorable stream quotes with database storage
- **Emote Responses**: Automatic chat responses to specific trigger words
- **Viewer Stats**: Track viewer participation and engagement with detailed analytics
- **Analytics**: Record stream data for later analysis including peak viewers, message counts, and session tracking
- **Spotify Playback**: Queue management and song history with automatic track monitoring
- **Automatic Token Refresh**: Maintains authentication without manual intervention
- **Stream Lifecycle**: Detects stream start/end and manages resources accordingly
- **Database Integration**: SQL-based persistence for all bot data and analytics
