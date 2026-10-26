import { createApp } from 'vue'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import { createI18n } from 'vue-i18n'
import AiInspectorApp from './AiInspectorApp.vue'
import zhCN from './locales/zh-CN.json'
import zhTW from './locales/zh-TW.json'
import enUS from './locales/en-US.json'

const start = async () => {
const bootstrap = await window.aiTraceApi.bootstrap()
const locale = ['zh-CN','zh-TW','en-US'].includes(bootstrap.setting?.language) ? bootstrap.setting.language
  : /^zh-(TW|HK)/i.test(bootstrap.locale) ? 'zh-TW' : String(bootstrap.locale).startsWith('zh') ? 'zh-CN' : 'en-US'
document.documentElement.className = bootstrap.setting?.theme || 'light'
const app = createApp(AiInspectorApp, { initialSelection: bootstrap.selection || {} })
app.use(ElementPlus)
app.use(createI18n({ locale, fallbackLocale:'zh-CN', legacy:false, messages:{'zh-CN':zhCN,'zh-TW':zhTW,'en-US':enUS} }))
app.mount('#ai-inspector-app')
}
start().catch(error => { document.body.textContent = String(error.message || error) })
