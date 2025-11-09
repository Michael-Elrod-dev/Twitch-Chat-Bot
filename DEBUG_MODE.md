# Debug Mode Documentation

## Overview

Debug mode allows you to run the bot with full functionality even when the stream is offline. This is useful for testing commands, AI responses, and other features without needing to be live.

## Features

- ✅ **Separate Debug Database**: All database changes go to `<your_db>_debug` instead of production
- ✅ **Separate Debug Logs**: All logs written to `debug-bot-*.log` and `debug-error-*.log`
- ✅ **Real Twitch Chat**: Uses actual Twitch chat (even when offline) for testing
- ✅ **Database Mirroring**: Starts with fresh copy of production data every time
- ✅ **Database Preservation**: Debug database preserved after shutdown for inspection
- ✅ **Full Bot Functionality**: All features work as if stream were live

## How to Use

### Starting Debug Mode

```bash
npm run debug
```

### Starting Normal Mode

```bash
npm start
```

## What Happens in Debug Mode

### On Startup:

1. **Database Setup**
   - Checks if `<your_db>_debug` exists
   - Drops existing debug database (if any)
   - Creates fresh `<your_db>_debug` database
   - Copies schema from production database
   - Copies ALL current data from production to debug database

2. **Logging**
   - Switches to debug log files: `debug-bot-*.log`, `debug-error-*.log`
   - All logs separated from production logs

3. **Bot Operation**
   - Bypasses stream live check
   - Forces full bot operation (as if stream were live)
   - Connects to real Twitch chat
   - All database writes go to debug database

### During Debug Session:

- **Chat**: Type in Twitch chat (even offline) - bot processes normally
- **Commands**: All commands work (`!quote`, `!chats`, `!aion`, etc.)
- **AI**: Mention `@almosthadai` or `almosthadai` to trigger AI responses
- **Analytics**: All viewer tracking, message counts, etc. are logged
- **Database**: All changes written to debug database only

### On Shutdown:

1. Closes all connections gracefully
2. **Preserves debug database** (does NOT delete it)
3. You can inspect `<your_db>_debug` after shutdown
4. Next debug startup will recreate fresh copy from production

## Inspecting Debug Data

After running in debug mode, you can inspect what happened:

```sql
-- Connect to debug database
USE <your_db>_debug;

-- View chat messages logged during debug session
SELECT * FROM chat_messages ORDER BY message_time DESC LIMIT 20;

-- View viewer activity
SELECT * FROM viewers;

-- View AI usage
SELECT * FROM api_usage;

-- View quotes added
SELECT * FROM quotes ORDER BY saved_at DESC;
```

## Log Files

### Debug Mode Logs:
- `src/logger/logs/debug-bot-<date>.log` - All bot activity
- `src/logger/logs/debug-error-<date>.log` - Errors only

### Production Mode Logs:
- `src/logger/logs/bot-<date>.log` - All bot activity
- `src/logger/logs/error-<date>.log` - Errors only

## Testing Workflows

### Example Test Session:

1. Start debug mode: `npm run debug`
2. Wait for "Bot initialization complete"
3. In Twitch chat (channel: aimosthadme), test:
   - `!commands` - Test basic command
   - `@almosthadai what's up?` - Test AI response
   - `!quote` - Get random quote
   - `!aion` / `!aioff` - Toggle AI (as mod)
4. Ctrl+C to shutdown gracefully
5. Inspect `<your_db>_debug` to verify data

### Testing New Features:

1. Make code changes
2. Start debug mode
3. Test feature in real chat
4. Check debug logs for any errors
5. Inspect debug database to verify data changes
6. Shutdown and review results

## Important Notes

- ⚠️ **Stream Status**: Bot ignores actual stream status in debug mode
- ⚠️ **Production Safety**: Production database and logs are NEVER touched
- ⚠️ **Chat Requirements**: Twitch chat works offline, but you must be connected to internet
- ⚠️ **Data Reset**: Debug database recreated fresh every debug startup
- ✅ **Safe Testing**: Feel free to test destructive commands - only affects debug DB

## Troubleshooting

### "Database already exists" error
- Should auto-delete on startup
- Manual fix: `DROP DATABASE <your_db>_debug;`

### Chat not responding
- Verify you're typing in correct channel (aimosthadme)
- Check debug logs for errors
- Ensure Twitch connection is working

### AI not responding
- Check if AI is enabled (`!aion`)
- Verify Claude API key is set in database
- Check debug logs for rate limit messages

### Database permission errors
- Ensure MySQL user has CREATE/DROP database permissions
- Check .env file has correct DB credentials
