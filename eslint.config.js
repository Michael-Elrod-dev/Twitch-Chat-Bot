const js = require('@eslint/js');
const globals = require('globals');
const tseslint = require('typescript-eslint');

/**
 * One bot, one language.
 *
 * The Phase-0 CommonJS block and its Jest globals were removed with the legacy
 * tree in P1-LR; the only JavaScript left in the repo is this config and the
 * handful of tooling scripts beside it.
 */
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

    // ---- Repo tooling: the CommonJS config files at the root --------------
    {
        files: ['*.js'],
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

    // ---- The application: TypeScript ESM ----------------------------------
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
