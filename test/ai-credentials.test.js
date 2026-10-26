const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto')
const { AiCredentialStore } = require('../modules/ai_credentials.js')

const fixture = async t => {
  const storePath = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-credentials-'))
  assert.equal(path.dirname(path.resolve(storePath)), path.resolve(os.tmpdir()))
  t.after(() => fs.rm(storePath, { recursive: true, force: true }))
  const secret = randomBytes(32)
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', secret, iv)
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext])
    },
    decryptString(buffer) {
      const decipher = createDecipheriv('aes-256-gcm', secret, buffer.subarray(0, 12))
      decipher.setAuthTag(buffer.subarray(12, 28))
      return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8')
    }
  }
  return { storePath, safeStorage, store: new AiCredentialStore({ storePath, safeStorage }) }
}

test('AI credential is encrypted, persists across instances, and clears explicitly', async t => {
  const { store, storePath, safeStorage } = await fixture(t)
  assert.equal(await store.get(), '')
  assert.equal(await store.has(), false)
  await store.set('private-ai-key')
  const persisted = await fs.readFile(store.filePath, 'utf8')
  assert.doesNotMatch(persisted, /private-ai-key/)
  assert.equal(JSON.parse(persisted).version, 1)
  const reopened = new AiCredentialStore({ storePath, safeStorage })
  assert.equal(await reopened.get(), 'private-ai-key')
  assert.equal(await reopened.has(), true)
  await reopened.clear()
  assert.equal(await store.has(), false)
  await reopened.clear()
})

test('AI blank credential does not erase an existing key', async t => {
  const { store } = await fixture(t)
  await store.set('private-ai-key')
  await assert.rejects(store.set('   '), { code: 'AI_EMPTY_KEY' })
  assert.equal(await store.get(), 'private-ai-key')
})

test('AI refuses plaintext fallback when system encryption is unavailable', async t => {
  const { store, storePath, safeStorage } = await fixture(t)
  safeStorage.isEncryptionAvailable = () => false
  await assert.rejects(store.set('private-ai-key'), { code: 'AI_ENCRYPTION_UNAVAILABLE' })
  assert.deepEqual(await fs.readdir(storePath), [])
  safeStorage.isEncryptionAvailable = () => true
  await store.set('private-ai-key')
  safeStorage.isEncryptionAvailable = () => false
  await assert.rejects(store.get(), { code: 'AI_ENCRYPTION_UNAVAILABLE' })
  await store.clear()
  assert.equal(await store.get(), '')
})

test('AI encryption failure preserves the stored key and emits no secret', async t => {
  const { store, safeStorage } = await fixture(t)
  await store.set('existing-key')
  const original = await fs.readFile(store.filePath, 'utf8')
  safeStorage.encryptString = () => { throw new Error('private-ai-key') }
  await assert.rejects(store.set('private-ai-key'), error => {
    assert.equal(error.code, 'AI_CREDENTIAL_ENCRYPT_FAILED')
    assert.doesNotMatch(error.message, /private-ai-key/)
    return true
  })
  assert.equal(await fs.readFile(store.filePath, 'utf8'), original)
  assert.equal(await store.get(), 'existing-key')
})

test('AI reports corrupt credentials instead of silently treating them as absent', async t => {
  const { store } = await fixture(t)
  await fs.writeFile(store.filePath, '{broken private-ai-key')
  await assert.rejects(store.get(), { code: 'AI_CREDENTIAL_DECRYPT_FAILED' })
  await assert.rejects(store.has(), { code: 'AI_CREDENTIAL_DECRYPT_FAILED' })
  await store.set('replacement')
  assert.equal(await store.get(), 'replacement')
  await fs.writeFile(store.filePath, JSON.stringify({ version: 1, encryptedKey: 'broken' }))
  await assert.rejects(store.get(), { code: 'AI_CREDENTIAL_DECRYPT_FAILED' })
})

test('AI key replacements and clear are serialized without temporary leftovers', async t => {
  const { store, storePath } = await fixture(t)
  await Promise.all([store.set('first'), store.set('second')])
  assert.equal(await store.get(), 'second')
  assert.deepEqual(await fs.readdir(storePath), ['ai-credentials.json'])
  await Promise.all([store.set('third'), store.clear()])
  assert.equal(await store.get(), '')
  assert.deepEqual(await fs.readdir(storePath), [])
})
