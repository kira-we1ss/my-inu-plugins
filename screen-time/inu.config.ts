import { defineConfig } from '@inugram/cli'

export default defineConfig({
  plugins: {
    'screen-time': {
      entry: 'src/screen-time/index.ts',
      manifest: {
        id: 'local.kweiss.screen-time',
        name: 'Screen Time',
        author: 'kweiss',
        version: '1.0.0',
        description: {
          en: 'Tracks time spent in the app, per screen type and per chat. All data stays on device.',
          ru: 'Считает время, проведённое в приложении: по типам экранов и по чатам. Данные хранятся только локально.',
        },
        icon: 'inu://eye',
        grants: [
          'onAppVisibilityChange',
          'account.read(self, peers, dialogs)',
        ],
      },
    },
  },
})
