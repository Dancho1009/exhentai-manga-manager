import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './theme.styl'
import '@imengyu/vue3-context-menu/lib/vue3-context-menu.css'
import ContextMenu from '@imengyu/vue3-context-menu'
import { createI18n } from 'vue-i18n'
import _ from 'lodash'
import BookDetailWindow from './BookDetailWindow.vue'
import zhCn from './locales/zh-CN.json'
import zhTw from './locales/zh-TW.json'
import enUs from './locales/en-US.json'

const messages = { 'zh-CN': zhCn, 'zh-TW': zhTw, 'en-US': enUs }

const resolveLocale = (setting, systemLocale) => {
  if (['zh-CN', 'zh-TW', 'en-US'].includes(setting.language)) return setting.language
  if (String(systemLocale).startsWith('zh-TW') || String(systemLocale).startsWith('zh-HK')) return 'zh-TW'
  return String(systemLocale).startsWith('zh') ? 'zh-CN' : 'en-US'
}

const bootstrap = async () => {
  const initialBootstrap = await window.bookDetailApi.getBootstrap()
  const locale = resolveLocale(initialBootstrap.setting || {}, initialBootstrap.locale)
  document.documentElement.className = initialBootstrap.setting?.theme || 'light e-hentai'
  if (initialBootstrap.setting?.customCss) {
    const style = document.createElement('style')
    style.textContent = initialBootstrap.setting.customCss
    document.head.appendChild(style)
  }
  window._ = _
  const app = createApp(BookDetailWindow, { initialBootstrap })
  app.use(createPinia())
  app.use(ElementPlus)
  app.use(ContextMenu)
  app.use(createI18n({ locale, fallbackLocale: 'zh-CN', globalInjection: true, legacy: false, messages }))
  app.mount('#book-detail-app')
}

bootstrap().catch(error => {
  console.error(error)
  document.body.textContent = String(error?.message || error)
})
