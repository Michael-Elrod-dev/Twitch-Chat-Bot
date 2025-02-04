// src/commandManager.js
const fs = require('fs');
const path = require('path');
const specialHandlers = require('./specialHandlers');

class CommandManager {
    constructor() {
        this.commandsPath = path.join(__dirname, '..', 'data', 'commands.json');
        this.loadCommands();
    }

    loadCommands() {
        try {
            if (!fs.existsSync(this.commandsPath)) {
                this.data = {
                    commands: {},
                    nonPrefixCommands: {}
                };
                this.saveCommands();
            } else {
                const fileContent = fs.readFileSync(this.commandsPath, 'utf8');
                this.data = JSON.parse(fileContent);
            }
        } catch (error) {
            console.error('Error loading commands:', error);
            this.data = {
                commands: {},
                nonPrefixCommands: {}
            };
        }
    }

    saveCommands() {
        try {
            fs.writeFileSync(this.commandsPath, JSON.stringify(this.data, null, 4));
        } catch (error) {
            console.error('Error saving commands:', error);
        }
    }

    async handleCommand(client, target, context, message) {
        if (message === '!command' || message.startsWith('!command ')) {
            // Only allow mods and broadcaster to use this command
            if (!context.mod && !context.badges?.broadcaster) return;
            
            const args = message.split(' ');
            
            // If just !command with no args, show usage
            if (args.length === 1) {
                client.say(target, 'Usage: !command <add/edit/delete> !commandname [message]');
                return;
            }
     
            const action = args[1].toLowerCase();
            
            // If has action but missing command name
            if (args.length < 3) {
                client.say(target, 'Usage: !command <add/edit/delete> !commandname [message]');
                return;
            }
     
            const commandName = args[2].toLowerCase();
            
            if (!commandName.startsWith('!')) {
                client.say(target, 'Command must start with !');
                return;
            }
     
            switch (action) {
                case 'add': {
                    if (args.length < 4) {
                        client.say(target, 'Usage: !command add !commandname <message>');
                        return;
                    }
                    const response = args.slice(3).join(' ');
                    if (this.addCommand(commandName, response)) {
                        client.say(target, `Command ${commandName} has been added.`);
                    } else {
                        client.say(target, `Command ${commandName} already exists.`);
                    }
                    break;
                }
                case 'edit': {
                    if (args.length < 4) {
                        client.say(target, 'Usage: !command edit !commandname <new message>');
                        return;
                    }
                    const response = args.slice(3).join(' ');
                    if (this.editCommand(commandName, response)) {
                        client.say(target, `Command ${commandName} has been updated.`);
                    } else {
                        client.say(target, `Cannot edit ${commandName} (command doesn't exist or has special handling).`);
                    }
                    break;
                }
                case 'delete': {
                    if (this.deleteCommand(commandName)) {
                        client.say(target, `Command ${commandName} has been deleted.`);
                    } else {
                        client.say(target, `Cannot delete ${commandName} (command doesn't exist or has special handling).`);
                    }
                    break;
                }
                default:
                    client.say(target, 'Invalid action. Use !command <add/edit/delete> !commandname [message]');
            }
            return;
        }
     
        const args = message.slice(1).split(' ');
        const commandName = '!' + args[0].toLowerCase();
        const command = this.data.commands[commandName];
     
        if (!command) return;
        if (command.userLevel === 'mod' && !context.mod && !context.badges?.broadcaster) return;
     
        try {
            if (command.handler && specialHandlers[command.handler]) {
                await specialHandlers[command.handler](client, target, context, args.slice(1));
            } else {
                client.say(target, command.response);
            }
        } catch (error) {
            console.error(`Error executing command ${commandName}:`, error);
        }
     }

    addCommand(name, response, userLevel = 'everyone') {
        if (this.data.commands[name]) {
            return false;
        }
        this.data.commands[name] = {
            response,
            handler: null,
            userLevel
        };
        this.saveCommands();
        return true;
    }

    editCommand(name, response) {
        if (this.data.commands[name]) {
            if (this.data.commands[name].handler) {
                return false;
            }
            this.data.commands[name].response = response;
            this.saveCommands();
            return true;
        }
        return false;
    }

    deleteCommand(name) {
        if (this.data.commands[name] && !this.data.commands[name].handler) {
            delete this.data.commands[name];
            this.saveCommands();
            return true;
        }
        return false;
    }

    getAllCommands() {
        return this.data.commands;
    }
}

module.exports = new CommandManager();