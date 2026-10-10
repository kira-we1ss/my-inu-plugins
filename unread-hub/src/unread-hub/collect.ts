import type { AccountSelection, HubConfig } from './config.js'

/** One unread message in the aggregated feed. */
export interface UnreadItem {
  /** unique key of the entry on the hub screen: `${markedPeerId}:${messageId}` */
  key: string
  /** marked peer id of the chat the message belongs to */
  markedPeer: number
  /** marked peer id of the sender (the source chat when the message has no from_id) */
  senderPeer: number
  date: number
  id: number
  /** detached synthetic message handed to the chat history screen */
  message: tl.TypeMessage
}

const CONCURRENCY = 5

/** safety valve for pathological unread counts: history pages are server roundtrips */
const MAX_SCAN_PER_CHAT = 2000

const DIALOG_FIELDS = ['unread_count', 'read_inbox_max_id', 'top_message', 'folder_id'] as const

interface DialogSnapshot {
  markedPeer: number
  topMessage: number
  readInboxMaxId: number
  unreadCount: number
}

function markedPeerId(peer: unknown): number | null {
  if (peer === null || typeof peer !== 'object') return null
  try {
    const marked = inu.utils.peers.getMarkedPeerId(peer as PeerLikeObject)
    return marked === 0 ? null : marked
  } catch {
    return null
  }
}

function isBroadcastChannel(account: inu.Account, markedPeer: number): boolean {
  if (inu.utils.peers.parseMarkedPeerId(markedPeer).type !== 'channel') return false
  const chat = account.getChat(markedPeer)
  return chat !== null && 'broadcast' in chat && chat.broadcast === true
    && (!('megagroup' in chat) || chat.megagroup !== true)
}

export function markedToPeer(marked: number): tl.TypePeer {
  const parsed = inu.utils.peers.parseMarkedPeerId(marked)
  switch (parsed.type) {
    case 'user': return { _: 'peerUser', user_id: parsed.id }
    case 'chat': return { _: 'peerChat', chat_id: parsed.id }
    case 'channel': return { _: 'peerChannel', channel_id: parsed.id }
  }
}

function isUser(peer: tl.TypeUser | tl.TypeChat): peer is tl.TypeUser {
  return String(peer._).startsWith('user')
}

function chatTitleOf(account: inu.Account, marked: number): string {
  const peer = account.getPeer(marked)
  if (peer === null) return String(marked)
  if (isUser(peer)) {
    const name = [peer.first_name, peer.last_name].filter(Boolean).join(' ')
    if (name !== '') return name
    if (peer.username !== undefined && peer.username !== '') return `@${peer.username}`
    return String(marked)
  }
  if (typeof peer.title === 'string' && peer.title !== '') return peer.title
  return String(marked)
}

/**
 * Builds the detached synthetic message for one incoming unread message.
 * The media and entities stay live views: they are deep-serialized when the page crosses to the app.
 */
function toItem(
  account: inu.Account,
  message: inu.Message,
  markedPeer: number,
): UnreadItem | null {
  if (message.out || message.isService) return null
  const raw = message.raw
  const rawMedia = raw.media
  const media = rawMedia == null || rawMedia._ === 'messageMediaEmpty' ? null : rawMedia
  let text = message.text
  if (text === '' && media === null) {
    // media, stickers, gifts, ...: use the app's own chat-list preview ("📷 Photo" and such)
    text = account.previewMessage(message).text
  }
  if (text === '' && media === null) return null

  const chatTitle = chatTitleOf(account, markedPeer)
  const header = `${chatTitle}\n`
  const senderPeer = raw.from_id == null ? null : markedPeerId(raw.from_id)
  const entities: tl.TypeMessageEntity[] = [
    { _: 'messageEntityBold', offset: 0, length: chatTitle.length },
  ]
  const sourceEntities = raw.entities
  // raw.entities is a TL vector: no .map, only length and indexed access
  if (sourceEntities != null) {
    for (let i = 0; i < sourceEntities.length; i++) {
      entities.push({ ...sourceEntities[i], offset: sourceEntities[i].offset + header.length })
    }
  }
  const synthetic: tl.TypeMessage = {
    _: 'message',
    id: message.id,
    peer_id: markedToPeer(markedPeer),
    from_id: markedToPeer(senderPeer ?? markedPeer),
    date: message.date,
    message: `${header}${text}`,
    entities,
    media: media ?? undefined,
    grouped_id: raw.grouped_id,
    out: false,
  }
  return {
    key: `${markedPeer}:${message.id}`,
    markedPeer,
    senderPeer: senderPeer ?? markedPeer,
    date: message.date,
    id: message.id,
    message: synthetic,
  }
}

/** Synchronously snapshots a just-arrived message into an item; the event's views may not outlive the turn. */
export function liveItem(account: inu.Account, message: inu.Message): UnreadItem | null {
  const peer = message.raw.peer_id
  if (peer == null) return null
  const markedPeer = markedPeerId(peer)
  if (markedPeer === null) return null
  return toItem(account, message, markedPeer)
}

// --- chat folders ---

interface FolderRule {
  chatlist: boolean
  contacts: boolean
  nonContacts: boolean
  groups: boolean
  broadcasts: boolean
  bots: boolean
  excludeMuted: boolean
  excludeArchived: boolean
  includePeers: Set<number>
  excludePeers: Set<number>
}

function peerSet(peers: readonly tl.TypeInputPeer[] | undefined): Set<number> {
  const out = new Set<number>()
  if (peers === undefined) return out
  // peers is a TL vector: no iteration protocol, only length and indexed access
  for (let i = 0; i < peers.length; i++) {
    const marked = markedPeerId(peers[i])
    if (marked !== null) out.add(marked)
  }
  return out
}

function folderRule(filter: tl.TypeDialogFilter): FolderRule | null {
  if (filter._ !== 'dialogFilter' && filter._ !== 'dialogFilterChatlist') return null
  return {
    chatlist: filter._ === 'dialogFilterChatlist',
    contacts: filter.contacts === true,
    nonContacts: filter.non_contacts === true,
    groups: filter.groups === true,
    broadcasts: filter.broadcasts === true,
    bots: filter.bots === true,
    excludeMuted: filter.exclude_muted === true,
    excludeArchived: filter.exclude_archived === true,
    includePeers: new Set([...peerSet(filter.pinned_peers), ...peerSet(filter.include_peers)]),
    excludePeers: peerSet(filter.exclude_peers),
  }
}

async function loadFolderRules(account: inu.Account, folderIds: readonly number[]): Promise<FolderRule[]> {
  if (folderIds.length === 0) return []
  const response = await account.invokeRpc({ _: 'messages.getDialogFilters' } as tl.messages.RawGetDialogFilters)
  const filters = response !== null && response._ === 'messages.dialogFilters' ? response.filters : null
  const rules: FolderRule[] = []
  if (filters != null) {
    // filters is a TL vector: no iteration protocol, only length and indexed access
    for (let i = 0; i < filters.length; i++) {
      const filter = filters[i]
      if (filter._ !== 'dialogFilter' && filter._ !== 'dialogFilterChatlist') continue
      if (!folderIds.includes(filter.id)) continue
      const rule = folderRule(filter)
      if (rule !== null) rules.push(rule)
    }
  }
  return rules
}

/**
 * Whether [marked] belongs in a folder. `exclude_read` is never tested: the hub only ever asks
 * about unread dialogs and just-arrived messages, which are unread by definition.
 */
function matchesFolderRule(account: inu.Account, marked: number, rule: FolderRule): boolean {
  if (rule.excludePeers.has(marked)) return false
  if (rule.includePeers.has(marked)) return true
  if (rule.chatlist) return false

  const parsed = inu.utils.peers.parseMarkedPeerId(marked)
  let typeMatches: boolean
  if (parsed.type === 'user') {
    const user = account.getUser(marked)
    if (user === null || user._ !== 'user') return false
    if (user.bot === true) typeMatches = rule.bots
    else typeMatches = user.contact === true ? rule.contacts : rule.nonContacts
  } else if (parsed.type === 'chat') {
    typeMatches = rule.groups
  } else {
    typeMatches = isBroadcastChannel(account, marked) ? rule.broadcasts : rule.groups
  }
  if (!typeMatches) return false

  if (rule.excludeArchived) {
    const dialog = account.getDialog(marked)
    if (dialog !== null && dialog._ === 'dialog' && dialog.folder_id) return false
  }
  if (rule.excludeMuted && account.isDialogMuted(marked)) return false
  return true
}

const FOLDER_RULES_TTL_MS = 30_000
let folderRulesCache: { accountSlot: number, folderIds: string, fetchedAt: number, rules: FolderRule[] } | null = null

/** Drops the cached folder rules, e.g. after the selection changed. */
export function invalidateFolderRules(): void {
  folderRulesCache = null
}

async function folderRules(account: inu.Account, folderIds: readonly number[]): Promise<FolderRule[]> {
  const key = folderIds.join(',')
  const cached = folderRulesCache
  if (
    cached !== null
    && cached.accountSlot === account.id
    && cached.folderIds === key
    && Date.now() - cached.fetchedAt < FOLDER_RULES_TTL_MS
  ) {
    return cached.rules
  }
  const rules = await loadFolderRules(account, folderIds)
  folderRulesCache = { accountSlot: account.id, folderIds: key, fetchedAt: Date.now(), rules }
  return rules
}

// --- backfill ---

async function dialogSnapshots(
  account: inu.Account,
  config: HubConfig,
  selection: AccountSelection,
): Promise<DialogSnapshot[]> {
  const folderIds = [0]
  if (config.includeArchived || config.mode === 'selected') folderIds.push(1)
  const rules = config.mode === 'selected' ? await folderRules(account, selection.folders) : []

  const snapshots: DialogSnapshot[] = []
  const seen = new Set<number>()
  for (const folderId of folderIds) {
    for await (const dialog of account.iterDialogs({ folderId, batchSize: 100, fields: DIALOG_FIELDS })) {
      if (dialog._ !== 'dialog' || dialog.unread_count <= 0) continue
      const marked = markedPeerId(dialog.peer)
      if (marked === null || seen.has(marked)) continue
      seen.add(marked)
      if (isBroadcastChannel(account, marked)) continue
      if (config.mode === 'selected'
        && !selection.peers.includes(marked)
        && !rules.some(rule => matchesFolderRule(account, marked, rule))) continue
      snapshots.push({
        markedPeer: marked,
        topMessage: dialog.top_message,
        readInboxMaxId: dialog.read_inbox_max_id,
        unreadCount: dialog.unread_count,
      })
    }
  }
  return snapshots
}

async function readDialog(account: inu.Account, snapshot: DialogSnapshot): Promise<UnreadItem[]> {
  const items: UnreadItem[] = []
  let scanned = 0
  let capped = false
  try {
    for await (const message of account.iterHistory(snapshot.markedPeer, { batchSize: 100 })) {
      if (message.id <= snapshot.readInboxMaxId) break
      if (scanned >= MAX_SCAN_PER_CHAT) {
        capped = true
        break
      }
      scanned++
      const item = toItem(account, message, snapshot.markedPeer)
      if (item !== null) items.push(item)
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`unread-hub: could not read the history of ${snapshot.markedPeer}, skipping it: ${reason}`)
    return []
  }
  if (items.length === 0 || capped) {
    console.warn(`[unread-hub:backfill] peer=${snapshot.markedPeer} name=${chatTitleOf(account, snapshot.markedPeer)} unread=${snapshot.unreadCount} readMax=${snapshot.readInboxMaxId} scanned=${scanned} included=${items.length}${capped ? ' (scan cap)' : ''}`)
  }
  return items
}

function byNewestFirst(a: UnreadItem, b: UnreadItem): number {
  return b.date - a.date || b.id - a.id
}

/** Collects every unread message matching the configured filter, sorted newest first. */
export async function collectUnread(
  account: inu.Account,
  config: HubConfig,
  selection: AccountSelection,
): Promise<UnreadItem[]> {
  const snapshots = await dialogSnapshots(account, config, selection)
  console.warn(`[unread-hub:backfill] unreadDialogs=${snapshots.length}; includeArchived=${config.includeArchived}; mode=${config.mode}`)

  const items: UnreadItem[] = []
  for (let at = 0; at < snapshots.length; at += CONCURRENCY) {
    const chunk = await Promise.all(snapshots.slice(at, at + CONCURRENCY).map(snapshot => readDialog(account, snapshot)))
    for (const part of chunk) items.push(...part)
  }
  items.sort(byNewestFirst)
  console.warn(`[unread-hub:backfill] totalItems=${items.length}`)
  return items
}

/** Whether a message from [markedPeer] belongs in the hub under the current configuration. */
export async function matchesFilter(
  account: inu.Account,
  markedPeer: number,
  config: HubConfig,
  selection: AccountSelection,
): Promise<boolean> {
  if (isBroadcastChannel(account, markedPeer)) return false
  if (config.mode === 'all') {
    if (config.includeArchived) return true
    const dialog = account.getDialog(markedPeer)
    return dialog === null || dialog._ !== 'dialog' || !dialog.folder_id
  }
  if (selection.peers.includes(markedPeer)) return true
  if (selection.folders.length === 0) return false
  const rules = await folderRules(account, selection.folders)
  return rules.some(rule => matchesFolderRule(account, markedPeer, rule))
}
