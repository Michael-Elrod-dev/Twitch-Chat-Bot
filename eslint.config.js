const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
    {
        ignores: ['coverage/**', 'logs/**', 'temp_backups/**']
    },

    js.configs.recommended,

    {
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.es2021
            }
        },
        rules: {
            indent: ['error', 4],
            'linebreak-style': ['error', 'unix'],
            quotes: ['error', 'single'],
            semi: ['error', 'always'],
            'no-unused-vars': 'warn',
            'no-console': 'off',

            // Enabled explicitly: it only joins eslint:recommended at @eslint/js v10,
            // and a wrapped throw that drops its cause loses the actual failure.
            'preserve-caught-error': 'error'
        }
    },

    {
        files: ['tests/**/*.js'],
        languageOptions: {
            globals: {
                ...globals.jest
            }
        }
    }
];
