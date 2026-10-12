import angular from 'angular-eslint';
import nx from '@nx/eslint-plugin';
import baseConfig from '../../eslint.config.js';

export default [
  ...baseConfig,
  { files: ['**/*.ts'], processor: angular.processInlineTemplates },
  ...nx.configs['flat/angular'],
  {
    files: ['**/*.ts'],
    rules: {
      // Newly added to the angular-eslint v22 recommended set; was not enforced
      // before the upgrade (components opt out via the Angular 22 migration).
      '@angular-eslint/prefer-on-push-component-change-detection': 'off',
      '@angular-eslint/directive-selector': [
        'error',
        {
          type: 'attribute',
          prefix: 'tapiz',
          style: 'camelCase',
        },
      ],
      '@angular-eslint/component-selector': [
        'error',
        {
          type: 'element',
          prefix: 'tapiz',
          style: 'kebab-case',
        },
      ],
      '@angular-eslint/no-host-metadata-property': 'off',
    },
  },
  // Same rule set as the former eslintrc `plugin:@nx/angular-template` preset
  // (template recommended only). Nx's `flat/angular-template` also adds the
  // accessibility set, which was never enabled here.
  ...angular.configs.templateRecommended.map((config) => ({
    ...config,
    files: ['**/*.html'],
  })),
];
