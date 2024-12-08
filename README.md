# Twitch Chat Bot

A Twitch chat bot built with Node.js that responds to user commands and provides utility functions for Twitch channels. The bot supports both default commands and allows moderators to create custom commands dynamically.

## Features

### Command Management
- Dynamic command creation, editing, and deletion by moderators
- Persistent storage of custom commands in JSON format
- Support for both prefix (!) and non-prefix commands
- User level restrictions (mod-only commands)

### Built-in Commands
- `!commands <add/edit/delete> !commandname [message]` - Mod-only command for managing custom commands
- `!follow` - Shows how long a user has been following the channel
- `!uptime` - Displays how long the stream has been live
- `!fursona` - Generates a unique fursona image for the user
- `!waifu` - Creates a personalized anime character for the user
- `!anime` - Links to AniList profile
- `!discord` - Provides Discord server invite

### System Features
- Automatic token management with 30-day refresh
- Error handling and logging
- API integration with Twitch and third-party services
- Configurable channel and command settings

## Setup

1. Create a `files/tokens.txt` in the following format:
```
AccessToken:your_access_token
RefreshToken:your_refresh_token
ClientID:your_client_id
```

2. Configure the channels list in `tokenManager.js`

3. Install dependencies:
```bash
npm install
```

4. Start the bot:
```bash
node src/bot.js
```

## Architecture
- `bot.js` - Main entry point and event handlers
- `commandManager.js` - Handles command processing and storage
- `tokenManager.js` - Manages authentication and token refresh
- `specialHandlers.js` - Contains special command implementations
- `utils.js` - Utility functions
- `commands.json` - Default command configuration

## Dependencies
- tmi.js - Twitch chat integration
- node-fetch - API requests
- fs/path - File system operations
