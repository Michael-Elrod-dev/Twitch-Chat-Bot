// src/commands/commands.js
module.exports = {
    name: 'commands',
    userLevel: 'mod',
    execute: (client, target, context, args) => {
        const commandManager = require('./commandManager');
        
        // Check if user is mod or broadcaster
        if (!context.mod && !context.badges?.broadcaster) {
            return;
        }

        if (args.length < 2) {
            client.say(target, 'Usage: !commands <add/edit/delete> !commandname [message]');
            return;
        }

        const action = args[0].toLowerCase();
        const commandName = args[1].toLowerCase();
        
        // Make sure command starts with !
        if (!commandName.startsWith('!')) {
            client.say(target, 'Command must start with !');
            return;
        }

        switch (action) {
            case 'add':
            case 'new': {
                if (args.length < 3) {
                    client.say(target, 'Usage: !commands add !commandname <message>');
                    return;
                }
                const response = args.slice(2).join(' ');
                if (commandManager.addCommand(commandName, response)) {
                    client.say(target, `Command ${commandName} has been added.`);
                } else {
                    client.say(target, `Command ${commandName} already exists.`);
                }
                break;
            }

            case 'edit': {
                if (args.length < 3) {
                    client.say(target, 'Usage: !commands edit !commandname <new message>');
                    return;
                }
                const response = args.slice(2).join(' ');
                if (commandManager.editCommand(commandName, response)) {
                    client.say(target, `Command ${commandName} has been updated.`);
                } else {
                    client.say(target, `Cannot edit ${commandName} (command doesn't exist or is a default command).`);
                }
                break;
            }

            case 'delete':
            case 'remove': {
                if (commandManager.deleteCommand(commandName)) {
                    client.say(target, `Command ${commandName} has been deleted.`);
                } else {
                    client.say(target, `Cannot delete ${commandName} (command doesn't exist or is a default command).`);
                }
                break;
            }

            default:
                client.say(target, 'Invalid action. Use !commands <add/edit/delete> !commandname [message]');
        }
    }
};