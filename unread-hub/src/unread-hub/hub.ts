import type { AccountSelection, HubConfig } from './config.js'
import { loadConfig, saveConfig, selectionFor } from './config.js'
import { collectUnread, liveItem, matchesFilter } from './collect.js'
import type { UnreadItem } from './collect.js'

const PAGE_SIZE = 50
const PLACEHOLDER_KEY = 'hub:placeholder'

function placeholderItem(account: inu.Account, text: string): UnreadItem {
  const self: tl.TypePeer = { _: 'peerUser', user_id: account.userId }
  const date = Math.floor(Date.now() / 1000)
  return {
    key: PLACEHOLDER_KEY,
    markedPeer: account.userId,
    senderPeer: account.userId,
    date,
    id: 1,
    message: {
      _: 'message',
      id: 1,
      peer_id: self,
      from_id: self,
      date,
      message: text,
      out: true,
    },
  }
}

function toEntry(item: UnreadItem): inu.ui.ChatHistoryEntry {
  return { key: item.key, message: item.message }
}

/**
 * The renderer names and draws senders from the app's peer cache; entries reference peers the app
 * may not have cached yet, so every page carries the ones it touches.
 */
function peersForPage(account: inu.Account, items: readonly UnreadItem[]): Pick<inu.ui.ChatHistoryPage, 'users' | 'chats'> {
  const users = new Map<number, tl.TypeUser>()
  const chats = new Map<number, tl.TypeChat>()
  for (const item of items) {
    for (const marked of [item.markedPeer, item.senderPeer]) {
      const parsed = inu.utils.peers.parseMarkedPeerId(marked)
      if (parsed.type === 'user') {
        const user = account.getUser(marked)
        if (user !== null) users.set(parsed.id, user)
      } else {
        const chat = account.getChat(marked)
        if (chat !== null) chats.set(parsed.id, chat)
      }
    }
  }
  return { users: [...users.values()], chats: [...chats.values()] }
}

function subtitleOf(config: HubConfig, selection: AccountSelection): string {
  if (config.mode === 'all') return config.includeArchived ? 'Все чаты, включая архив' : 'Все чаты'
  const parts: string[] = []
  if (selection.folders.length > 0) parts.push(`папок: ${selection.folders.length}`)
  if (selection.peers.length > 0) parts.push(`чатов: ${selection.peers.length}`)
  return parts.length > 0 ? `Выбранные (${parts.join(', ')})` : 'Выбранные (ничего не выбрано)'
}

class Hub {
  readonly accountSlot: number
  isClosed = false

  private readonly account: inu.Account
  private readonly openSettings: () => void
  private handle: inu.ui.ChatHistory | null = null
  /** feed entries, newest first */
  private items: UnreadItem[] = []
  private loaded = false
  private collecting: Promise<void> | null = null

  constructor(account: inu.Account, openSettings: () => void) {
    this.account = account
    this.accountSlot = account.id
    this.openSettings = openSettings
  }

  open(): void {
    const config = loadConfig()
    const handle = inu.ui.openChatHistory({
      title: 'Unread hub',
      subtitle: subtitleOf(config, selectionFor(config, this.account.userId)),
      icon: inu.icons.common('eye'),
      account: this.account.id,
      synthetic: true,
      avatars: true,
      load: (cursor, direction) => this.load(cursor, direction),
      onRead: key => this.onRead(key),
      menu: () => this.menuItems(),
    })
    this.handle = handle
    handle.closed.then(() => {
      this.isClosed = true
      this.handle = null
      if (activeHub === this) activeHub = null
    })
  }

  close(): void {
    this.handle?.close()
  }

  private async collect(): Promise<void> {
    this.collecting ??= (async () => {
      const config = loadConfig()
      try {
        this.items = await collectUnread(this.account, config, selectionFor(config, this.account.userId))
      } catch (error) {
        console.warn('unread-hub: collection failed', error)
        const reason = error instanceof Error ? error.message : String(error)
        this.items = [placeholderItem(this.account, `Не удалось собрать непрочитанные: ${reason}`)]
      }
      if (this.items.length === 0) {
        this.items = [placeholderItem(this.account, 'Непрочитанных нет 🎉')]
      }
      this.loaded = true
    })()
    await this.collecting
  }

  private async load(cursor: string | null, direction: 'older' | 'newer'): Promise<inu.ui.ChatHistoryPage> {
    // (null, 'older') is the initial "where do we start" request; everything later pages by key
    if (cursor === null && direction === 'older' && !this.loaded) await this.collect()

    let slice: UnreadItem[]
    let next: string | undefined
    if (cursor === null) {
      // both the initial page and the jump-to-bottom one are the newest page
      slice = this.items.slice(0, PAGE_SIZE)
      if (this.items.length > slice.length) next = slice[slice.length - 1].key
    } else {
      const index = this.items.findIndex(item => item.key === cursor)
      if (index === -1) {
        // an entry that is gone (hidden as read, stale after a refresh): end this direction
        return { entries: [] }
      }
      if (direction === 'older') {
        slice = this.items.slice(index + 1, index + 1 + PAGE_SIZE)
        if (index + 1 + PAGE_SIZE < this.items.length && slice.length > 0) next = slice[slice.length - 1].key
      } else {
        const start = Math.max(0, index - PAGE_SIZE)
        slice = this.items.slice(start, index)
        if (start > 0 && slice.length > 0) next = slice[0].key
      }
    }
    return {
      entries: slice.map(toEntry),
      ...peersForPage(this.account, slice),
      next,
      unreadCount: this.items.filter(item => item.key !== PLACEHOLDER_KEY).length,
    }
  }

  private onRead(key: string): void {
    if (!loadConfig().hideSeen) return
    if (key === PLACEHOLDER_KEY) return
    const index = this.items.findIndex(item => item.key === key)
    if (index === -1) return
    // the key is the newest entry on screen: it and everything older count as seen
    const seen = this.items.splice(index)
    const keys = seen.map(item => item.key)
    this.handle?.remove(keys)
    this.handle?.setUnreadCount(this.items.length)
  }

  /** A new message arrived on the hub's account and passed the filter. */
  addLive(item: UnreadItem): void {
    if (this.handle === null || !this.loaded) return
    if (this.items.some(existing => existing.key === item.key)) return

    const placeholderIndex = this.items.findIndex(item => item.key === PLACEHOLDER_KEY)
    if (placeholderIndex !== -1) {
      this.items.splice(placeholderIndex, 1)
      this.handle.remove([PLACEHOLDER_KEY])
    }

    // entries stay sorted newest first; the screen itself can only append at the bottom
    const newerThan = (existing: UnreadItem): boolean =>
      item.date > existing.date || (item.date === existing.date && item.id > existing.id)
    const at = this.items.findIndex(existing => newerThan(existing))
    const index = at === -1 ? this.items.length : at
    this.items.splice(index, 0, item)
    if (index === 0) {
      this.handle.append({ entries: [toEntry(item)], ...peersForPage(this.account, [item]), unreadCount: this.items.length })
    } else {
      // an out-of-order arrival (e.g. catch-up): it appears on the next refresh
      this.handle.setUnreadCount(this.items.length)
    }
  }

  private async refresh(): Promise<void> {
    const config = loadConfig()
    let fresh: UnreadItem[]
    try {
      fresh = await collectUnread(this.account, config, selectionFor(config, this.account.userId))
    } catch (error) {
      console.warn('unread-hub: refresh failed', error)
      inu.ui.toast('Не удалось обновить ленту')
      return
    }
    if (this.handle === null) return

    if (fresh.length === 0) fresh = [placeholderItem(this.account, 'Непрочитанных нет 🎉')]
    const freshKeys = new Set(fresh.map(item => item.key))
    const oldKeys = new Set(this.items.map(item => item.key))
    const removedKeys = this.items.filter(item => !freshKeys.has(item.key)).map(item => item.key)
    const added = fresh.filter(item => !oldKeys.has(item.key))
    this.items = fresh

    if (removedKeys.length > 0) this.handle.remove(removedKeys)
    if (added.length > 0) this.handle.append({ entries: added.map(toEntry), ...peersForPage(this.account, added), unreadCount: fresh.length })
    else this.handle.setUnreadCount(fresh.length)
  }

  private menuItems(): inu.ui.ChatHistoryMenuItem[] {
    const config = loadConfig()
    return [
      {
        text: 'Обновить',
        icon: inu.icons.common('refresh'),
        onClick: () => {
          void this.refresh().catch((error: unknown) => {
            console.warn('unread-hub: refresh failed', error)
          })
        },
      },
      {
        text: 'Скрывать просмотренные',
        checked: config.hideSeen,
        onClick: () => {
          const current = loadConfig()
          current.hideSeen = !current.hideSeen
          saveConfig(current)
        },
      },
      {
        text: 'Настройки',
        icon: inu.icons.common('settings'),
        onClick: () => this.openSettings(),
      },
    ]
  }
}

let activeHub: Hub | null = null

export function openHub(account: inu.Account, openSettings: () => void): void {
  if (activeHub !== null) {
    activeHub.close()
    activeHub = null
  }
  const hub = new Hub(account, openSettings)
  activeHub = hub
  hub.open()
}

export function handleNewMessage(message: inu.Message, account: inu.Account): void {
  const hub = activeHub
  if (hub === null || hub.isClosed || account.id !== hub.accountSlot) return
  if (message.out || message.isService) return

  let item: UnreadItem | null
  try {
    // event message views are only reliable inside this turn, so snapshot synchronously
    item = liveItem(account, message)
  } catch (error) {
    console.warn('unread-hub: could not snapshot a new message', error)
    return
  }
  if (item === null) return

  const config = loadConfig()
  const selection = selectionFor(config, account.userId)
  matchesFilter(account, item.markedPeer, config, selection)
    .then((matches) => {
      if (matches) hub.addLive(item)
    })
    .catch((error: unknown) => {
      console.warn('unread-hub: filter check failed for a new message', error)
    })
}
