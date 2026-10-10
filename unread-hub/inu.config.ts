import { defineConfig } from '@inugram/cli'

export default defineConfig({
  outDir: 'dist',
  plugins: {
    'unread-hub': {
      entry: 'src/unread-hub/index.ts',
      manifest: {
        id: 'dev.kweiss.unread-hub',
        name: 'Unread hub',
        author: 'kweiss',
        version: '1.0.0',
        description: {
          en: 'Aggregates unread messages from all or selected chats into a single virtual chat',
          ru: 'Собирает непрочитанные сообщения из всех или выбранных чатов в один виртуальный чат',
        },
        icon: 'inu://eye',
        grants: [
          'account.read(dialogs)',
          'account.read(history)',
          'account.read(peers)',
          'account.read(messages)',
          'invokeRpc(messages.getDialogFilters)',
          'onUpdate(new_message)',
        ],
      },
    },
  },
})
