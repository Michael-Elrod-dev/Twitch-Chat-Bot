const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

/** Style rules shared by the legacy JS and the new TypeScript workspaces. */
const houseStyle = {
    indent: ['error', 4],
    'linebreak-style': ['error', 'unix'],
    quotes: ['error', 'single'],
    semi: ['error', 'always'],
    'no-console': 'off',

    // A leading underscore marks a binding that must exist but is not
    // used - Express middleware arity, for instance.
    'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_'
    }],

    // Enabled explicitly: it only joins eslint:recommended at @eslint/js v10,
    // and a wrapped throw that drops its cause loses the actual failure.
    'preserve-caught-error': 'error'
};

module.exports = [
    {
        ignores: [
            'coverage/**',
            'logs/**',
            'temp_backups/**',
            '**/dist/**'
        ]
    },

    // ---- Legacy Phase-0 bot: CommonJS JavaScript --------------------------
    {
        files: ['src/**/*.js', 'tests/**/*.js', '*.js'],
        ...js.configs.recommended,
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'commonjs',
            globals: {
                ...globals.node,
                ...globals.es2021
            }
        },
        rules: {
            ...js.configs.recommended.rules,
            ...houseStyle
        }
    },

    {
        // jest.setup.js runs inside the Jest environment too, so it gets the
        // same globals as the suites themselves.
        files: ['tests/**/*.js', 'jest.setup.js'],
        languageOptions: {
            globals: {
                ...globals.jest
            }
        }
    },

    // ---- Phase-1 workspaces: TypeScript ESM -------------------------------
    ...tseslint.configs.recommended.map((config) => ({
        ...config,
        files: ['server/**/*.ts', 'shared/**/*.ts']
    })),

    {
        files: ['server/**/*.ts', 'shared/**/*.ts'],
        languageOptions: {
            ecmaVersion: 'latest',
            sourceType: 'module',
            globals: {
                ...globals.node
            }
        },
        rules: {
            ...houseStyle,

            // The TypeScript-aware version understands type-only imports and
            // declaration merging, so the base rule must yield to it.
            'no-unused-vars': 'off',
            '@typescript-eslint/no-unused-vars': ['warn', {
                argsIgnorePattern: '^_',
                caughtErrorsIgnorePattern: '^_'
            }]
        }
    },

    // Config files at the workspace roots are tooling, not shipped code.
    {
        files: ['**/vitest.config.ts', '**/*.config.ts'],
        rules: {
            '@typescript-eslint/no-unused-vars': 'off'
        }
    }
];
