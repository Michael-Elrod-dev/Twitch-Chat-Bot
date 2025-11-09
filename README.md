# AlmostHadAI Twitch Bot

A Twitch chat bot featuring AI-powered chat responses (via Claude), Spotify queue automation, channel point redemptions, dynamic commands, and comprehensive database-driven analytics.

## Directory Structure

```
src/
├── ai/                        # AI integration and management
│   ├── models/                # AI model implementations
│   │   └── claudeModel.js     # Claude text generation
│   ├── aiManager.js           # Central AI coordination and rate limiting
│   └── rateLimiter.js         # Per-user AI usage limits and tracking
├── analytics/                 # Stream and chat analytics
│   ├── viewers/               # Viewer tracking and statistics
│   │   └── viewerTracker.js   # Viewer interaction tracking
│   └── analyticsManager.js    # Central analytics coordination
├── commands/                  # Command handling
│   ├── commandManager.js      # Custom command management
│   └── specialCommandHandlers.js # Built-in command implementations
├── config/                    # Configuration
│   └── config.js              # App-wide configuration including AI settings
├── database/                  # Database management
│   ├── dbManager.js           # Database connection handling
│   └── schema.sql             # Database schema including AI usage tracking
├── emotes/                    # Emote response system
│   └── emoteManager.js        # Emote trigger and response handling
├── logger/                    # Logging system
│   ├── logger.js              # Winston-based structured logging
│   └── logs/                  # Log file directory (gitignored)
├── messages/                  # Message handling
│   ├── chatMessageHandler.js  # Chat message processing with AI integration
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
│   ├── eventHandler.js        # EventSub event handling (placeholder)
│   ├── subscriptionManager.js # EventSub subscription management
│   └── webSocketManager.js    # WebSocket connection handling
└── bot.js                     # Main application entry point
```

## Key Components

### Core Bot (`bot.js`)
- Initializes all subsystems and manages their lifecycle
- Coordinates between components via dependency injection
- Establishes event subscriptions and message routing
- Handles stream start/end detection with automatic resource management
- **Graceful Shutdown**: 30-minute auto-shutdown after stream offline or Ctrl+C for immediate shutdown
- **Crash Recovery**: Automatically cleans up orphaned sessions from previous crashes on startup
- Manages database connections and SQL-based data persistence with guaranteed integrity
- Tracks current stream sessions and comprehensive viewer analytics

### AI Integration (`ai/`)
- **aiManager.js**: Coordinates AI requests with rate limiting and user permission handling
- **models/claudeModel.js**: Handles Claude API for contextual chat responses
- **rateLimiter.js**: Enforces per-user AI usage limits with database tracking

### Database Layer (`database/`)
- **dbManager.js**: Handles MySQL database connections with transaction support
- **schema.sql**: Defines database structure for analytics, commands, emotes, user data, and AI usage tracking

### Authentication & API (`tokens/`)
- **tokenManager.js**: Manages OAuth tokens for Twitch, Spotify, and AI services with automatic refreshing
- **twitchAPI.js**: Provides methods for interacting with Twitch API including channel point management

### Event Handling (`websocket/`)
- **webSocketManager.js**: Maintains WebSocket connection to Twitch EventSub with automatic reconnection
- **subscriptionManager.js**: Sets up event subscriptions for chat, channel points, and stream status
- **eventHandler.js**: Placeholder for future specialized event handling logic

### Message Processing (`messages/`)
- **chatMessageHandler.js**: Processes chat messages with AI trigger detection and response routing
- **messageSender.js**: Handles sending messages to Twitch chat with token validation
- **redemptionHandler.js**: Processes channel point redemptions with analytics tracking

### Commands (`commands/`)
- **commandManager.js**: Manages custom commands with database storage, caching, and permission levels
- **specialCommandHandlers.js**: Implements built-in commands including stats, quotes, and Spotify controls

### Emote System (`emotes/`)
- **emoteManager.js**: Handles automatic emote responses with database storage and caching

### Channel Point Features (`redemptions/`)
- **redemptionManager.js**: Routes redemptions to handlers and manages status updates
- **quotes/**: Quote saving and retrieval system with database persistence
- **songs/**: Spotify song request and queue management with database-backed queue

### Spotify Integration (`redemptions/songs/`)
- **spotifyManager.js**: Manages Spotify authentication and playback with automatic queue monitoring
- **queueManager.js**: Handles song queue with database persistence and priority support
- **songRequest.js**: Processes song requests with validation and error handling

### Analytics & Viewer Tracking (`analytics/`)
- **analyticsManager.js**: Coordinates comprehensive stream and chat data collection
- **viewers/viewerTracker.js**: Tracks viewer participation, message counts, and AI usage statistics

### Logging System (`logger/`)
- **logger.js**: Winston-based structured logging with multiple log levels (debug, info, warn, error)
- **Size-based rotation**: Automatically rotates logs when files reach 20MB
- **Retention policy**: Keeps last 10 log files, automatically deletes older ones
- **Separate error logs**: Dedicated error log files for quick troubleshooting
- **Crash-safe**: Uses last known activity timestamps for accurate analytics even after crashes

## Features

### AI-Powered Responses
- **Text Responses**: Context-aware chat responses via Claude AI with @mentions
- **Rate Limiting**: Per-user usage limits with different tiers for mods/subscribers
- **Smart Triggers**: Responds to @almosthadai mentions in chat

### Chat Management
- **Custom Commands**: Create, edit, and manage chat commands with permission levels
- **Emote Responses**: Automatic responses to trigger words with database storage
- **Dynamic Permissions**: Role-based access control for commands and features

### Spotify Integration
- **Song Requests**: Channel point integration with automatic queue management
- **Queue Management**: Priority and regular queues with database persistence
- **Playback Control**: Automatic track monitoring and playlist archiving
- **Mod Controls**: Skip songs, toggle requests, and manage queue

### Channel Point Features
- **Quote System**: Save and retrieve memorable quotes with database storage
- **Song Requests**: Spotify integration with validation and error handling
- **Redemption Management**: Automatic status updates and point refunds

### Analytics & Tracking
- **Viewer Stats**: Comprehensive participation tracking including AI usage
- **Stream Analytics**: Peak viewers, message counts, and session data
- **Usage Tracking**: AI request monitoring and rate limit enforcement
- **Database Persistence**: All data stored in MySQL with proper relationships

### Advanced Features
- **Stream Lifecycle Management**: Automatic resource management based on stream status
- **Graceful Shutdown**: Database integrity protection with automatic data saves
- **Auto-Shutdown Timer**: 30-minute grace period after stream offline (recovers from internet outages)
- **Crash Recovery**: Orphaned session cleanup using last chat activity timestamps
- **Token Management**: Automatic refresh for all API services
- **Error Handling**: Comprehensive error recovery and user feedback
- **Structured Logging**: Winston-based logging with rotation and retention policies
- **Modular Architecture**: Easy to extend with new features and integrations

## Running the Bot

### Start the Bot
```bash
npm start
```
or
```bash
node src/bot.js
```

### Stop the Bot
- **Graceful Shutdown**: Press `Ctrl+C` to safely stop the bot
  - Saves all stream analytics
  - Closes viewer sessions properly
  - Ensures database integrity
  - Closes all connections cleanly

### Automatic Shutdown
- Bot automatically shuts down 30 minutes after stream goes offline
- Countdown warnings logged at 15min, 5min, 1min remaining
- Cancels shutdown if stream comes back online (internet outage recovery)

### Log Files
All logs are stored in `src/logger/logs/`:
- `bot-YYYY-MM-DD-HHmmss.log` - All logs (info, debug, warn, error)
- `error-YYYY-MM-DD-HHmmss.log` - Error logs only

To enable debug logging, edit `src/config/config.js`:
```javascript
this.logging = {
    level: 'debug',  // Change from 'info' to 'debug'
    maxSize: '20m',
    maxFiles: 10
}
```

## Configuration

The bot supports extensive configuration through environment variables and `config.js`:
- AI model settings and rate limits
- Database connection parameters
- API endpoints and authentication
- Feature toggles and permissions
- Caching intervals and timeouts

## Database Schema

Includes tables for:
- User analytics and session tracking
- Command and emote management
- AI usage tracking and rate limiting
- Song queue and quote storage
- Stream analytics and viewer statistics
