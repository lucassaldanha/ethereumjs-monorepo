module.exports = {
  extends: '../../config/eslint.cjs',
  parserOptions: {
    project: ['./tsconfig.lint.json'],
  },
  rules: {
    '@typescript-eslint/no-use-before-define': 'off',
    'no-invalid-this': 'off',
    'no-restricted-syntax': 'off',
  },
  overrides: [
    {
      files: ['examples/**/*'],
      rules: {
        'no-console': 'off',
        '@typescript-eslint/no-unused-vars': 'off',
      },
    },
  ],
}
