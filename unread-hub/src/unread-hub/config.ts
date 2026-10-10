export interface AccountSelection {
  /** chat folder ids, see inu.ChatFolder.id */
  folders: number[]
  /** marked peer ids picked via inu.ui.selectPeers */
  peers: number[]
}

export interface HubConfig {
  mode: 'all' | 'selected'
  includeArchived: boolean
  /** locally hide entries the user scrolled past in the hub; source chats are never touched */
  hideSeen: boolean
  /** selections are per account, keyed by user id: folder ids differ between accounts */
  perAccount: Record<string, AccountSelection>
}

const STORAGE_KEY = 'unread-hub:config:v1'

function defaultConfig(): HubConfig {
  return { mode: 'all', includeArchived: false, hideSeen: false, perAccount: {} }
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(item => typeof item === 'number' && Number.isSafeInteger(item))
}

function sanitizePerAccount(value: unknown): Record<string, AccountSelection> {
  const out: Record<string, AccountSelection> = {}
  if (value === null || typeof value !== 'object') return out
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') continue
    const { folders, peers } = entry as Record<string, unknown>
    out[key] = {
      folders: isNumberArray(folders) ? folders : [],
      peers: isNumberArray(peers) ? peers : [],
    }
  }
  return out
}

export function loadConfig(): HubConfig {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) return defaultConfig()
  try {
    const parsed = JSON.parse(raw) as Partial<HubConfig>
    return {
      mode: parsed.mode === 'selected' ? 'selected' : 'all',
      includeArchived: parsed.includeArchived === true,
      hideSeen: parsed.hideSeen === true,
      perAccount: sanitizePerAccount(parsed.perAccount),
    }
  } catch (error) {
    console.warn('unread-hub: stored config is unreadable, falling back to defaults', error)
    return defaultConfig()
  }
}

export function saveConfig(config: HubConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
}

/**
 * The selection of [userId] inside [config]. Returns the live object:
 * mutate it, then persist with saveConfig(config).
 */
export function selectionFor(config: HubConfig, userId: number): AccountSelection {
  const key = String(userId)
  let selection = config.perAccount[key]
  if (selection === undefined) {
    selection = { folders: [], peers: [] }
    config.perAccount[key] = selection
  }
  return selection
}
