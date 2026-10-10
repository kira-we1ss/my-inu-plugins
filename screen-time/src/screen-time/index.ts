type ScreenType = 'chat' | 'profile' | 'dialogs' | 'settings' | 'other'

interface DayRecord {
  /** ms per screen type */
  s: Record<string, number>
  /** ms per chat (marked peer id as string), including time spent in its topics */
  c: Record<string, number>
  /** ms per forum topic (`{marked peer id}:{topic id}`) */
  t: Record<string, number>
}

interface Session {
  slot: number
  type: ScreenType
  dialogId: number | null
  topicId: number | null
  startMs: number
}

const RETENTION_DAYS = 30
const FLUSH_INTERVAL_MS = 30_000
const COLLAPSED_CHATS = 10
const BAR_WIDTH = 12
const GENERAL_TOPIC_ID = 1
/** time in a forum outside any topic (e.g. the topic list) shorter than this is not worth a row */
const MIN_REMAINDER_MS = 1000

const SCREEN_LABELS: Record<ScreenType, string> = {
  chat: 'Чаты',
  profile: 'Профили',
  dialogs: 'Список диалогов',
  settings: 'Настройки',
  other: 'Прочее',
}

const PERIODS = ['Сегодня', '7 дней']

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function dayKeyOf(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** local midnight following the day containing `ms` */
function nextMidnight(ms: number): number {
  const d = new Date(ms)
  d.setHours(24, 0, 0, 0)
  return d.getTime()
}

function storageKey(slot: number, day: string): string {
  return `d:${slot}:${day}`
}

function emptyRecord(): DayRecord {
  return { s: {}, c: {}, t: {} }
}

function addTo(record: DayRecord, type: ScreenType, dialogId: number | null, topicId: number | null, ms: number) {
  record.s[type] = (record.s[type] ?? 0) + ms
  if (dialogId !== null) {
    const key = String(dialogId)
    record.c[key] = (record.c[key] ?? 0) + ms
    if (topicId !== null) {
      const topicKey = `${dialogId}:${topicId}`
      record.t[topicKey] = (record.t[topicKey] ?? 0) + ms
    }
  }
}

function mergeInto(target: DayRecord, source: DayRecord) {
  for (const [type, ms] of Object.entries(source.s)) {
    target.s[type] = (target.s[type] ?? 0) + ms
  }
  for (const [id, ms] of Object.entries(source.c)) {
    target.c[id] = (target.c[id] ?? 0) + ms
  }
  for (const [id, ms] of Object.entries(source.t)) {
    target.t[id] = (target.t[id] ?? 0) + ms
  }
}

function readStored(key: string): DayRecord {
  const raw = localStorage.getItem(key)
  if (raw === null) return emptyRecord()
  try {
    const parsed = JSON.parse(raw) as Partial<DayRecord>
    return { s: parsed.s ?? {}, c: parsed.c ?? {}, t: parsed.t ?? {} }
  } catch (error) {
    console.warn(`screen-time: dropping unreadable record ${key}:`, error)
    return emptyRecord()
  }
}

/** accumulated since the last flush, keyed like localStorage (`d:{slot}:{day}`) */
const pending = new Map<string, DayRecord>()

function accumulate(
  slot: number,
  type: ScreenType,
  dialogId: number | null,
  topicId: number | null,
  fromMs: number,
  toMs: number,
) {
  let cursor = fromMs
  while (cursor < toMs) {
    const boundary = Math.min(nextMidnight(cursor), toMs)
    const key = storageKey(slot, dayKeyOf(cursor))
    let record = pending.get(key)
    if (record === undefined) {
      record = emptyRecord()
      pending.set(key, record)
    }
    addTo(record, type, dialogId, topicId, boundary - cursor)
    cursor = boundary
  }
}

function prune() {
  const cutoff = dayKeyOf(Date.now() - RETENTION_DAYS * 86_400_000)
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('d:')) continue
    const day = key.slice(key.indexOf(':', 2) + 1)
    if (day < cutoff) localStorage.removeItem(key)
  }
}

function flush() {
  if (pending.size !== 0) {
    const batch: Record<string, string> = {}
    for (const [key, record] of pending) {
      const stored = readStored(key)
      mergeInto(stored, record)
      batch[key] = JSON.stringify(stored)
    }
    pending.clear()
    localStorage.setItems(batch)
  }
  prune()
}

// --- tracking ---

/** the app was explicitly backgrounded or paused; screen changes are ignored until it returns */
let suspended = false
let current: Session | null = null

function closeSession(nowMs: number) {
  if (current === null) return
  if (nowMs > current.startMs) {
    accumulate(current.slot, current.type, current.dialogId, current.topicId, current.startMs, nowMs)
  }
  current = null
}

function openSession(screen: inu.ui.CurrentScreen | null, nowMs: number) {
  if (screen === null) return
  const isPeerScreen = screen.type === 'chat' || screen.type === 'profile'
  current = {
    slot: screen.account.id,
    type: screen.type,
    dialogId: isPeerScreen && typeof screen.dialogId === 'number' ? screen.dialogId : null,
    topicId: screen.type === 'chat' && typeof screen.topicId === 'number' ? screen.topicId : null,
    startMs: nowMs,
  }
}

{
  openSession(inu.ui.getCurrentScreen(), Date.now())
}

inu.ui.onScreenChanged((change) => {
  if (suspended) return
  const now = Date.now()
  closeSession(now)
  openSession(change.screen, now)
  flush()
})

inu.onAppVisibilityChange((mode) => {
  if (mode === 'background' || mode === 'paused') {
    suspended = true
    closeSession(Date.now())
    flush()
  } else {
    suspended = false
    closeSession(Date.now())
    openSession(inu.ui.getCurrentScreen(), Date.now())
    flush()
  }
})

setInterval(flush, FLUSH_INTERVAL_MS)

inu.onUnload(() => {
  closeSession(Date.now())
  flush()
})

// --- names ---

function peerNameOf(peer: tl.TypeUser | tl.TypeChat): string {
  if ('title' in peer && typeof peer.title === 'string') return peer.title
  const names = peer as { first_name?: string; last_name?: string; username?: string }
  const full = [names.first_name, names.last_name].filter(Boolean).join(' ')
  if (full !== '') return full
  if (names.username) return `@${names.username}`
  return ''
}

function accountOrNull(slot: number): inu.Account | null {
  try {
    return inu.account(slot)
  } catch (error) {
    if (error instanceof inu.PluginError && error.code === 'not-found') return null
    throw error
  }
}

function chatLabel(slot: number, dialogId: number): string {
  const account = accountOrNull(slot)
  if (account !== null) {
    const peer = account.getUser(dialogId) ?? account.getChat(dialogId)
    if (peer !== null) {
      const name = peerNameOf(peer)
      if (name !== '') {
        localStorage.setItem(`n:${slot}:${dialogId}`, name)
        return name
      }
    }
  }
  return localStorage.getItem(`n:${slot}:${dialogId}`) ?? `#${dialogId}`
}

function topicLabel(slot: number, dialogId: number, topicId: number): string {
  const account = accountOrNull(slot)
  if (account !== null) {
    const topic = account.getTopicCached(dialogId, topicId)
    if (topic !== null && topic._ === 'forumTopic' && topic.title !== '') {
      localStorage.setItem(`n:${slot}:${dialogId}:${topicId}`, topic.title)
      return topic.title
    }
  }
  const fallback = topicId === GENERAL_TOPIC_ID ? 'Общий' : `Топик #${topicId}`
  return localStorage.getItem(`n:${slot}:${dialogId}:${topicId}`) ?? fallback
}

/** a custom emoji id is a 64-bit number; `0`/empty mean "none" */
function emojiIconOrUndefined(id: string): inu.UIIcon | undefined {
  if (id === '' || id === '0') return undefined
  try {
    return inu.icons.customEmoji(id)
  } catch (error) {
    // an icon that fails must not take the whole page down with it
    console.warn(`screen-time: bad custom emoji id ${id}:`, error)
    return undefined
  }
}

/** the topic's custom emoji, if it has one; remembered like names so it survives a cache miss */
function topicIcon(slot: number, dialogId: number, topicId: number): inu.UIIcon | undefined {
  const cacheKey = `n:${slot}:${dialogId}:${topicId}:icon`
  const account = accountOrNull(slot)
  if (account !== null) {
    const topic = account.getTopicCached(dialogId, topicId)
    if (topic !== null && topic._ === 'forumTopic') {
      // typed as a string, but the runtime hands over a number (`0` when the topic has no emoji)
      const emojiId = topic.icon_emoji_id == null ? '' : String(topic.icon_emoji_id)
      if (emojiId !== '' && emojiId !== '0') {
        localStorage.setItem(cacheKey, emojiId)
      } else {
        localStorage.removeItem(cacheKey)
      }
      return emojiIconOrUndefined(emojiId)
    }
  }
  return emojiIconOrUndefined(localStorage.getItem(cacheKey) ?? '')
}

function accountLabel(slot: number): string {
  const account = accountOrNull(slot)
  if (account === null) return `Аккаунт ${slot} (удалён)`
  const me = account.getMe()
  const name = me !== null ? peerNameOf(me) : ''
  return name !== '' ? name : `Аккаунт ${slot} (${account.userId})`
}

// --- aggregation ---

function knownSlots(): number[] {
  const slots = new Set<number>()
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith('d:')) continue
    slots.add(Number(key.slice(2, key.indexOf(':', 2))))
  }
  for (const key of pending.keys()) {
    slots.add(Number(key.slice(2, key.indexOf(':', 2))))
  }
  if (current !== null) slots.add(current.slot)
  return [...slots].sort((a, b) => a - b)
}

interface Totals {
  screens: Map<ScreenType, number>
  /** `${slot}:${dialogId}` -> ms */
  chats: Map<string, number>
  /** `${slot}:${dialogId}` -> topic id -> ms */
  topics: Map<string, Map<number, number>>
  total: number
}

function aggregate(period: number, slotFilter: number): Totals {
  const days: string[] = []
  const now = Date.now()
  const count = period === 0 ? 1 : 7
  for (let i = 0; i < count; i++) {
    days.push(dayKeyOf(now - i * 86_400_000))
  }
  const slots = slotFilter >= 0 ? [slotFilter] : knownSlots()

  const totals: Totals = { screens: new Map(), chats: new Map(), topics: new Map(), total: 0 }
  const absorb = (slot: number, record: DayRecord) => {
    for (const [type, ms] of Object.entries(record.s)) {
      totals.screens.set(type as ScreenType, (totals.screens.get(type as ScreenType) ?? 0) + ms)
      totals.total += ms
    }
    for (const [id, ms] of Object.entries(record.c)) {
      const key = `${slot}:${id}`
      totals.chats.set(key, (totals.chats.get(key) ?? 0) + ms)
    }
    for (const [id, ms] of Object.entries(record.t)) {
      const sep = id.indexOf(':')
      const chatKey = `${slot}:${id.slice(0, sep)}`
      const topicId = Number(id.slice(sep + 1))
      let byTopic = totals.topics.get(chatKey)
      if (byTopic === undefined) {
        byTopic = new Map()
        totals.topics.set(chatKey, byTopic)
      }
      byTopic.set(topicId, (byTopic.get(topicId) ?? 0) + ms)
    }
  }
  for (const slot of slots) {
    for (const day of days) {
      const key = storageKey(slot, day)
      absorb(slot, readStored(key))
      const pendingRecord = pending.get(key)
      if (pendingRecord !== undefined) absorb(slot, pendingRecord)
    }
  }
  // the screen on the device right now counts too, up to this render
  if (current !== null && (slotFilter < 0 || current.slot === slotFilter)) {
    const live = emptyRecord()
    accumulateIntoLive(live, current, Date.now())
    absorb(current.slot, live)
  }
  return totals
}

function accumulateIntoLive(record: DayRecord, session: Session, nowMs: number) {
  if (dayKeyOf(session.startMs) === dayKeyOf(nowMs)) {
    addTo(record, session.type, session.dialogId, session.topicId, nowMs - session.startMs)
  }
  // a live session that crosses midnight is rare and only skews the "7 days"
  // view by where its elapsed part lands; the flush path splits it exactly
}

// --- formatting ---

function formatMs(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000)
  if (totalMinutes < 1) return `${Math.floor(ms / 1000)} сек`
  const days = Math.floor(totalMinutes / 1440)
  const hours = Math.floor((totalMinutes % 1440) / 60)
  const minutes = totalMinutes % 60
  const parts: string[] = []
  if (days > 0) parts.push(`${days} д`)
  if (hours > 0) parts.push(`${hours} ч`)
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes} мин`)
  return parts.join(' ')
}

function bar(ms: number, of: number): string {
  const ratio = of <= 0 ? 0 : ms / of
  const filled = Math.round(ratio * BAR_WIDTH)
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)} ${Math.round(ratio * 100)}%`
}

// --- dashboard ---

const uiState = {
  period: Math.min(Math.max(Number(localStorage.getItem('ui:period') ?? '0'), 0), PERIODS.length - 1),
  account: Number(localStorage.getItem('ui:account') ?? '-1'),
  showAllChats: false,
  /** chat keys (`${slot}:${dialogId}`) whose topics are unfolded */
  expanded: new Set<string>(),
}

function openChat(slot: number, dialogId: number, topicId?: number) {
  try {
    inu.ui.openPage({ type: 'chat', dialogId, topicId, account: slot })
  } catch (error) {
    console.warn(`screen-time: cannot open chat ${dialogId} (topic ${topicId}) on slot ${slot}:`, error)
    inu.ui.toast('Не удалось открыть чат')
  }
}

/** rows under an unfolded forum chat: its topics, then whatever was spent outside any topic */
function topicItems(slot: number, dialogId: number, chatMs: number, byTopic: Map<number, number>): inu.UIElement[] {
  const rows: inu.UIElement[] = []
  const sorted = [...byTopic.entries()].sort((a, b) => b[1] - a[1])
  let inTopics = 0
  for (const [, ms] of sorted) inTopics += ms
  for (const [topicId, ms] of sorted) {
    rows.push(inu.ui.button({
      id: `topic:${slot}:${dialogId}:${topicId}`,
      text: topicLabel(slot, dialogId, topicId),
      icon: topicIcon(slot, dialogId, topicId),
      subtitle: bar(ms, chatMs),
      value: formatMs(ms),
      onClick: () => openChat(slot, dialogId, topicId),
    }))
  }
  const outside = chatMs - inTopics
  if (outside >= MIN_REMAINDER_MS) {
    rows.push(inu.ui.button({
      id: `topic:${slot}:${dialogId}:outside`,
      text: 'Вне топиков',
      subtitle: bar(outside, chatMs),
      value: formatMs(outside),
      onClick: () => {},
    }))
  }
  return rows
}

function dashboardItems(): inu.UIElement[] {
  const slots = knownSlots()
  if (uiState.account >= 0 && !slots.includes(uiState.account)) uiState.account = -1
  const totals = aggregate(uiState.period, uiState.account)

  const items: inu.UIElement[] = [
    inu.ui.header('Экранное время'),
    inu.ui.select({
      id: 'period',
      text: 'Период',
      items: PERIODS,
      selected: uiState.period,
      onChange: (index) => {
        uiState.period = index
        localStorage.setItem('ui:period', String(index))
      },
    }),
  ]

  if (slots.length > 1) {
    items.push(inu.ui.select({
      id: 'account',
      text: 'Аккаунт',
      items: ['Все аккаунты', ...slots.map(accountLabel)],
      selected: uiState.account < 0 ? 0 : slots.indexOf(uiState.account) + 1,
      onChange: (index) => {
        uiState.account = index === 0 ? -1 : slots[index - 1]
        localStorage.setItem('ui:account', String(uiState.account))
      },
    }))
  }

  items.push(inu.ui.separator('данные хранятся только на устройстве, последние 30 дней'))

  if (totals.total === 0) {
    items.push(inu.ui.separator('пока нет данных за выбранный период'))
  } else {
    items.push(
      inu.ui.header(`Итого — ${PERIODS[uiState.period].toLowerCase()}`),
      inu.ui.button({
        id: 'total',
        text: 'Всего в приложении',
        value: formatMs(totals.total),
        onClick: () => {},
      }),
      inu.ui.header('По экранам'),
    )
    const screens = [...totals.screens.entries()].sort((a, b) => b[1] - a[1])
    for (const [type, ms] of screens) {
      items.push(inu.ui.button({
        id: `screen:${type}`,
        text: SCREEN_LABELS[type] ?? type,
        subtitle: bar(ms, totals.total),
        value: formatMs(ms),
        onClick: () => {},
      }))
    }
    if (totals.chats.size > 0) {
      items.push(inu.ui.header('Чаты'))
      const allChats = [...totals.chats.entries()].sort((a, b) => b[1] - a[1])
      const chats = uiState.showAllChats ? allChats : allChats.slice(0, COLLAPSED_CHATS)
      const topMs = chats[0][1]
      for (const [key, ms] of chats) {
        const sep = key.indexOf(':')
        const slot = Number(key.slice(0, sep))
        const dialogId = Number(key.slice(sep + 1))
        const byTopic = totals.topics.get(key)
        if (byTopic === undefined) {
          items.push(inu.ui.button({
            id: `chat:${key}`,
            text: chatLabel(slot, dialogId),
            subtitle: bar(ms, topMs),
            value: formatMs(ms),
            icon: inu.icons.avatar(dialogId, { account: slot }),
            onClick: () => openChat(slot, dialogId),
          }))
          continue
        }
        // a forum: tap unfolds its topics, long tap opens the chat itself
        const open = uiState.expanded.has(key)
        items.push(inu.ui.button({
          id: `chat:${key}`,
          text: `${open ? '▾' : '▸'} ${chatLabel(slot, dialogId)}`,
          subtitle: bar(ms, topMs),
          value: formatMs(ms),
          icon: inu.icons.avatar(dialogId, { account: slot }),
          onClick: () => {
            if (open) uiState.expanded.delete(key)
            else uiState.expanded.add(key)
            page.invalidate()
          },
          onSecondaryClick: () => openChat(slot, dialogId),
        }))
        if (open) items.push(...topicItems(slot, dialogId, ms, byTopic))
      }
      if (allChats.length > COLLAPSED_CHATS) {
        items.push(inu.ui.button({
          id: 'toggle-chats',
          text: uiState.showAllChats ? 'Свернуть список' : `Показать все чаты (${allChats.length})`,
          onClick: () => {
            uiState.showAllChats = !uiState.showAllChats
            page.invalidate()
          },
        }))
      }
    }
  }

  items.push(
    inu.ui.header('Управление'),
    inu.ui.button({
      id: 'refresh',
      text: 'Обновить',
      icon: inu.icons.common('refresh'),
      onClick: () => page.invalidate(),
    }),
    inu.ui.button({
      id: 'reset',
      text: 'Сбросить статистику',
      icon: inu.icons.common('delete'),
      danger: true,
      onClick: (anchor) => {
        anchor.openMenu([
          {
            text: 'Да, удалить всё',
            danger: true,
            onClick: () => {
              for (const key of Object.keys(localStorage)) {
                if (key.startsWith('d:') || key.startsWith('n:')) localStorage.removeItem(key)
              }
              pending.clear()
              inu.ui.toast('Статистика удалена')
              page.invalidate()
            },
          },
          { text: 'Отмена', onClick: () => {} },
        ])
      },
    }),
  )
  return items
}

const page = inu.ui.settingsPage({
  title: 'Screen Time',
  items: dashboardItems,
})

inu.registerSettings(page)
