# AlmostHadAI Twitch Bot

A comprehensive Twitch chat bot with Spotify integration, channel point redemptions, custom commands, and chat analytics stored in SQL.

## Technical Architecture

### Directory Structure

```
src/
├── analytics/                 # Stream and chat analytics
│   ├── collectors/            # Data collection modules
│   ├── db/                    # Database management
│   │   ├── dbManager.js       # Database connection handling
│   │   └── schema.sql         # Database schema
│   └── analyticsManager.js    # Central analytics coordination
├── commands/                  # Command handling
│   ├── commandManager.js      # Custom command management
│   └── specialCommandHandlers.js # Built-in command implementations
├── config/                    # Configuration
│   └── config.js              # App-wide configuration
├── data/                      # Persistent storage
│   ├── commands.json          # Custom commands storage
│   ├── db.json                # Database configuration
│   ├── emotes.json            # Emote response mappings
│   ├── pendingQueue.json      # Pending song queue
│   ├── quotes.json            # Saved quotes
│   ├── tokens.json            # API tokens
│   └── viewers.json           # Viewer statistics
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
├── viewers/                   # Viewer tracking
│   └── viewerManager.js       # Viewer statistics and management
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

### Authentication & API (`tokens/`)
- **tokenManager.js**: Manages OAuth tokens for Twitch and Spotify with automatic refreshing
- **twitchAPI.js**: Provides methods for interacting with Twitch API endpoints

### Event Handling (`websocket/`)
- **webSocketManager.js**: Maintains WebSocket connection to Twitch EventSub
- **subscriptionManager.js**: Sets up and manages event subscriptions
- **eventHandler.js**: Routes incoming events to appropriate handlers

### Message Processing (`messages/`)
- **chatMessageHandler.js**: Processes incoming chat messages and routes to commands
- **messageSender.js**: Handles sending messages to Twitch chat
- **redemptionHandler.js**: Processes channel point redemptions

### Commands (`commands/`)
- **commandManager.js**: Manages custom commands with storage and permission handling
- **specialCommandHandlers.js**: Implements built-in commands with complex functionality

### Channel Point Features (`redemptions/`)
- **redemptionManager.js**: Routes redemptions to appropriate handlers
- **quotes/**: Quote saving and retrieval system
- **songs/**: Spotify song request and queue management

### Spotify Integration (`redemptions/songs/`)
- **spotifyManager.js**: Authenticates with Spotify and manages playback
- **queueManager.js**: Manages pending song requests
- **songRequest.js**: Processes song request redemptions

### Viewer Tracking (`viewers/`)
- **viewerManager.js**: Tracks viewer participation statistics

### Analytics (`analytics/`)
- **analyticsManager.js**: Coordinates stream and chat data collection
- **dbManager.js**: Handles database connections and queries

## Features

- **Custom Commands**: Create, edit, and manage chat commands
- **Song Requests**: Channel point integration with Spotify
- **Quote System**: Save and retrieve memorable stream quotes
- **Viewer Stats**: Track viewer participation and engagement
- **Analytics**: Record stream data for later analysis
- **Spotify Playback**: Queue management and song history
- **Automatic Token Refresh**: Maintains authentication without manual intervention
- **Stream Lifecycle**: Detects stream start/end and manages resources accordingly

## Error Handling & Recovery

- Automatic reconnection on WebSocket disconnection
- Token refresh on authentication failures
- Graceful handling of API rate limits and errors
- Persistent storage for recovery between sessions
- Comprehensive logging for troubleshooting

## State Management

- Spotify playback state tracking
- Channel point redemption status updates
- Command state persistence
- Viewer statistics tracking
- Session-based analytics