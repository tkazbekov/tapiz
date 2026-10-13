import nx from '@nx/eslint-plugin';
import prettier from 'eslint-config-prettier/flat';

const tsFiles = ['**/*.ts', '**/*.tsx', '**/*.cts', '**/*.mts'];
const jsFiles = ['**/*.js', '**/*.jsx', '**/*.cjs', '**/*.mjs'];

export default [
  ...nx.configs['flat/base'],
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            {
              sourceTag: 'scope:web',
              onlyDependOnLibsWithTags: [
                'scope:web',
                'type:util',
                'type:ui',
                'type:feature',
              ],
            },
            {
              sourceTag: 'scope:server',
              onlyDependOnLibsWithTags: [
                'scope:server',
                'type:util',
                'type:feature',
              ],
              bannedExternalImports: ['@angular/*'],
            },
            {
              sourceTag: 'type:feature',
              onlyDependOnLibsWithTags: [
                'type:feature',
                'type:ui',
                'type:util',
              ],
            },
            {
              sourceTag: 'type:ui',
              onlyDependOnLibsWithTags: ['type:ui', 'type:util'],
            },
            {
              sourceTag: 'type:util',
              onlyDependOnLibsWithTags: ['type:util'],
            },
          ],
        },
      ],
    },
  },
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  prettier,
  {
    files: tsFiles,
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
      'no-multiple-empty-lines': [2, { max: 1 }],
      quotes: ['error', 'single', { avoidEscape: true }],
      'no-extra-semi': 'error',
    },
  },
  {
    files: jsFiles,
    rules: {
      'no-extra-semi': 'error',
    },
  },
  {
    ignores: [
      '**/.astro/**',
      '**/dist/**',
      '**/environment*.ts',
      '**/eslint.config.js',
      '**/vite.config.*.timestamp*',
      '**/vitest.config.*.timestamp*',
    ],
  },
];
