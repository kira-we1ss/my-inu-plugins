import type { AccountSelection, HubConfig } from './config.js'
import { loadConfig, saveConfig, selectionFor } from './config.js'
import { invalidateFolderRules } from './collect.js'

// the folder list is async, while items() is sync: keep a cache, kick a load when stale,
// and invalidate the page once it lands
let foldersCache: { userId: number, folders: inu.ChatFolder[] } | null = null
let foldersLoading = false

function ensureFolders(page: inu.ui.UIPage, account: inu.Account): void {
  if (foldersLoading) return
  if (foldersCache !== null && foldersCache.userId === account.userId) return
  foldersLoading = true
  account.getChatFoldersCached()
    .then((folders) => {
      foldersCache = { userId: account.userId, folders }
    })
    .catch((error: unknown) => {
      console.warn('unread-hub: could not load chat folders', error)
      foldersCache = { userId: account.userId, folders: [] }
    })
    .finally(() => {
      foldersLoading = false
      page.invalidate()
    })
}

function folderRows(
  page: inu.ui.UIPage,
  account: inu.Account,
  config: HubConfig,
  selection: AccountSelection,
): inu.UIElement[] {
  ensureFolders(page, account)
  if (foldersCache === null || foldersCache.userId !== account.userId) {
    return [inu.ui.button({ id: 'folders-loading', text: 'Загрузка папок…', onClick: () => {} })]
  }
  // the default "all chats" folder would make the selection mode meaningless
  const folders = foldersCache.folders.filter(folder => !folder.isDefault)
  if (folders.length === 0) return [inu.ui.separator('Папок нет — создайте их в Telegram')]
  return folders.map(folder => inu.ui.check({
    id: `folder-${folder.id}`,
    text: `${folder.emoticon !== null ? `${folder.emoticon} ` : ''}${folder.title.text}`,
    subtitle: `непрочитанных: ${folder.unreadCount}`,
    checked: selection.folders.includes(folder.id),
    onChange: (checked) => {
      selection.folders = checked
        ? [...selection.folders, folder.id]
        : selection.folders.filter(id => id !== folder.id)
      saveConfig(config)
      invalidateFolderRules()
    },
  }))
}

async function pickChats(account: inu.Account, config: HubConfig, selection: AccountSelection): Promise<void> {
  let picked: number[] | null
  try {
    picked = await inu.ui.selectPeers({
      title: 'Чаты для Unread hub',
      account: account.id,
      selected: selection.peers,
    })
  } catch (error) {
    console.warn('unread-hub: the peer picker failed', error)
    return
  }
  if (picked === null) return
  selection.peers = picked
  saveConfig(config)
}

export function createSettingsPage(openHub: () => void): inu.ui.UIPage {
  const page = inu.ui.settingsPage({
    title: 'Unread hub',
    items: () => {
      const config = loadConfig()
      const items: inu.UIElement[] = [
        inu.ui.header('Источник'),
        inu.ui.select({
          id: 'mode',
          text: 'Режим',
          items: [
            { text: 'Все чаты', subtitle: 'каждый диалог с непрочитанными' },
            { text: 'Выбранные', subtitle: 'только отмеченные папки и чаты' },
          ],
          selected: config.mode === 'all' ? 0 : 1,
          onChange: (index) => {
            config.mode = index === 0 ? 'all' : 'selected'
            saveConfig(config)
          },
        }),
      ]

      let account: inu.Account | null = null
      try {
        account = inu.account()
      } catch {
        // no logged-in account: the selection rows below are replaced with a hint
      }

      if (config.mode === 'selected') {
        if (account === null) {
          items.push(inu.ui.separator('Войдите в аккаунт, чтобы выбрать папки и чаты'))
        } else {
          const current = account
          const selection = selectionFor(config, current.userId)
          items.push(
            inu.ui.button({
              id: 'pick-chats',
              text: 'Чаты',
              icon: inu.icons.common('group'),
              value: selection.peers.length === 0 ? 'не выбраны' : String(selection.peers.length),
              onClick: () => {
                void pickChats(current, config, selection)
              },
            }),
            inu.ui.header('Папки'),
            ...folderRows(page, current, config, selection),
          )
        }
      }

      items.push(
        inu.ui.separator(),
        inu.ui.header('Поведение'),
        inu.ui.check({
          id: 'include-archived',
          text: 'Включать архив',
          subtitle: 'учитывать заархивированные чаты в режиме «Все чаты»',
          checked: config.includeArchived,
          onChange: (checked) => {
            config.includeArchived = checked
            saveConfig(config)
          },
        }),
        inu.ui.check({
          id: 'hide-seen',
          text: 'Скрывать просмотренные',
          subtitle: 'убирать из ленты сообщения, которые вы пролистали; в исходных чатах ничего не меняется',
          checked: config.hideSeen,
          onChange: (checked) => {
            config.hideSeen = checked
            saveConfig(config)
          },
        }),
        inu.ui.separator('Хаб только показывает непрочитанные и ничего не отмечает прочитанным в исходных чатах'),
        inu.ui.button({
          id: 'open-hub',
          text: 'Открыть Unread hub',
          icon: inu.icons.common('eye'),
          onClick: () => openHub(),
        }),
      )
      return items
    },
  })
  return page
}
