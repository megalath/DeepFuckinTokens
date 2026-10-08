import { defineConfig } from 'vitest/config'

// Live tests start real pi processes against real providers; opt in with DEEPTOKENS_LIVE=1.
const live = process.env['DEEPTOKENS_LIVE'] === '1'

export default defineConfig({
  resolve: { conditions: ['@deeptokens/source'] },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts'],
          exclude: ['**/*.live.test.ts'],
        },
      },
      ...(live
        ? [
            {
              extends: true,
              test: {
                name: 'live',
                include: ['packages/*/test/**/*.live.test.ts'],
                testTimeout: 300_000,
              },
            },
          ]
        : []),
    ],
  },
})
