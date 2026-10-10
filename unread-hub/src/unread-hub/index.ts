import { handleNewMessage, openHub } from './hub.js'
import { createSettingsPage } from './settings.js'

const settingsPage = createSettingsPage(() => {
  let account: inu.Account
  try {
    account = inu.account()
  } catch (error) {
    console.warn('unread-hub: no logged-in account', error)
    inu.ui.toast('Нет активного аккаунта')
    return
  }
  openHubFor(account)
})

inu.registerSettings(settingsPage)

function openHubFor(account: inu.Account): void {
  try {
    openHub(account, () => inu.ui.openPage(settingsPage))
  } catch (error) {
    console.warn('unread-hub: could not open the hub', error)
    inu.ui.toast('Не удалось открыть Unread hub')
  }
}

inu.registerGlobalAction({
  id: 'open-hub',
  text: 'Unread hub',
  icon: inu.icons.common('eye'),
  callback: (ctx) => openHubFor(ctx.account),
})

inu.onNewMessage((message, account) => handleNewMessage(message, account))
