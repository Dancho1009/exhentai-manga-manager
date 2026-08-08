import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import { createI18n } from 'vue-i18n'
import AuditApp from './AuditApp.vue'
import zhCn from './locales/zh-CN.json'
import zhTw from './locales/zh-TW.json'
import enUs from './locales/en-US.json'

const messages = { 'zh-CN': zhCn, 'zh-TW': zhTw, 'en-US': enUs }

const bootstrap = async () => {
  const [setting, systemLocale] = await Promise.all([
    window.auditApi.loadSetting(),
    window.auditApi.getLocale()
  ])
  const locale = setting.language === 'zh-CN' || setting.language === 'zh-TW' || setting.language === 'en-US'
    ? setting.language
    : String(systemLocale).startsWith('zh-TW') || String(systemLocale).startsWith('zh-HK') ? 'zh-TW'
      : String(systemLocale).startsWith('zh') ? 'zh-CN' : 'en-US'
  document.documentElement.className = setting.theme || 'light e-hentai'
  const app = createApp(AuditApp, { initialSetting: setting })
  app.use(ElementPlus)
  app.use(createI18n({ locale, fallbackLocale: 'zh-CN', globalInjection: true, legacy: false, messages }))
  app.mount('#audit-app')
}

bootstrap()
