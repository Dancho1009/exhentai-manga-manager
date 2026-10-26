const fs = require('fs/promises')
const path = require('path')
const { randomUUID } = require('crypto')

const credentialError = (code, message) => Object.assign(new Error(message), { code })

class AiCredentialStore {
  constructor({ storePath, safeStorage, slot = 'api' }) {
    const filenames = { api: 'ai-credentials.json', 'chatgpt-json': 'ai-chatgpt-json.json', 'chatgpt-account': 'ai-chatgpt-account.json' }
    if (!Object.hasOwn(filenames, slot)) throw credentialError('AI_INVALID_PROVIDER', '不支持的 AI 凭据类型。')
    this.filePath = path.join(storePath, filenames[slot])
    this.safeStorage = safeStorage
    this.pendingWrite = Promise.resolve()
  }

  ensureEncryption() {
    try {
      if (this.safeStorage?.isEncryptionAvailable()) return
    } catch {}
    throw credentialError('AI_ENCRYPTION_UNAVAILABLE', '系统密钥加密不可用，无法保存或读取 AI 凭据。')
  }

  async get() {
    await this.pendingWrite
    let text
    try { text = await fs.readFile(this.filePath, 'utf8') } catch (error) {
      if (error.code === 'ENOENT') return ''
      throw credentialError('AI_CREDENTIAL_READ_FAILED', '无法读取已保存的 AI Key。')
    }
    this.ensureEncryption()
    try {
      const data = JSON.parse(text)
      if (data.version !== 1 || typeof data.encryptedKey !== 'string' || !data.encryptedKey) throw new Error('INVALID_CREDENTIAL')
      const value = this.safeStorage.decryptString(Buffer.from(data.encryptedKey, 'base64'))
      if (typeof value !== 'string' || !value) throw new Error('INVALID_CREDENTIAL')
      return value
    } catch {
      throw credentialError('AI_CREDENTIAL_DECRYPT_FAILED', '无法解密已保存的 AI Key，请重新设置。')
    }
  }

  async has() { return Boolean(await this.get()) }

  enqueueWrite(operation) {
    const result = this.pendingWrite.then(operation)
    this.pendingWrite = result.catch(() => {})
    return result
  }

  set(value) {
    return this.enqueueWrite(async () => {
      const key = typeof value === 'string' ? value.trim() : ''
      if (!key) throw credentialError('AI_EMPTY_KEY', '请输入 AI Key；清除已保存的 Key 请使用清除操作。')
      this.ensureEncryption()
      let encryptedKey
      try { encryptedKey = this.safeStorage.encryptString(key).toString('base64') } catch {
        throw credentialError('AI_CREDENTIAL_ENCRYPT_FAILED', '无法加密 AI Key，原有 Key 保持不变。')
      }
      const temporary = `${this.filePath}.${randomUUID()}.tmp`
      try {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true })
        await fs.writeFile(temporary, JSON.stringify({ version: 1, encryptedKey }), { mode: 0o600 })
        await fs.rename(temporary, this.filePath)
      } catch {
        throw credentialError('AI_CREDENTIAL_WRITE_FAILED', '无法保存 AI Key。')
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => {})
      }
      return true
    })
  }

  clear() {
    return this.enqueueWrite(async () => {
      try { await fs.rm(this.filePath, { force: true }) } catch {
        throw credentialError('AI_CREDENTIAL_WRITE_FAILED', '无法清除已保存的 AI Key。')
      }
      return true
    })
  }
}

module.exports = { AiCredentialStore }
