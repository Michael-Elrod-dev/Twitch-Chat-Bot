# AlmostHadAI Twitch Bot

A feature-rich Twitch chat bot built with Node.js that combines traditional chat commands with Spotify integration and channel point redemptions. The bot provides both utility functions and entertainment features for Twitch channels.

## Core Features

### Chat Commands
- **Default Commands**
  - `!anime` - Links to AniList profile
  - `!discord` - Provides Discord server invite
  - `!follow` - Shows follow duration for users
  - `!uptime` - Displays stream duration
  - `!fursona` - Generates unique fursona image using thisfursonadoesnotexist.com
  - `!waifu` - Creates personalized anime character
  - Non-prefix responses for "kappa" and "kekw"

### Dynamic Command System
- Moderator command management using `!commands`
  - Add new commands: `!commands add !commandname <message>`
  - Edit existing: `!commands edit !commandname <new message>`
  - Remove commands: `!commands delete !commandname`
- Persistent storage of custom commands
- User permission levels (mod/everyone)

### Spotify Integration
- Channel point redemption for song requests
- Automatic queue management
- Features:
  - Direct queue addition when Spotify is active
  - Pending queue system for offline status
  - Automatic playlist tracking
  - New song detection and playlist addition
  - Error handling with point refunds

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
- `spotifyManager.js` - Handles Spotify authentication and playback control
- `redemptionManager.js` - Manages channel point redemptions
- `commandManager.js` - Command processing and storage
- `tokenManager.js` - Authentication token management

### Notable Features
- Automatic token refresh system
- Persistent queue management
- Error recovery systems
- Automatic Spotify device state monitoring
- Dynamic command persistence
- Modular architecture for easy feature expansion

## Authentication
The bot requires several authentication tokens:
- Twitch Bot Tokens
- Twitch Broadcaster Tokens
- Spotify API Tokens

Tokens are managed automatically with refresh capability.

## Dependencies
- `tmi.js` - Twitch chat integration
- `@twurple/api` - Twitch API integration
- `spotify-web-api-node` - Spotify control
- `node-fetch` - API requests
- Native Node.js modules (fs, path)

## Notes
- The bot automatically handles Spotify connection state
- Failed song requests are stored in a pending queue
- Commands are persistently stored between sessions
- Includes automatic error recovery systems
- Supports dynamic command modification during runtime