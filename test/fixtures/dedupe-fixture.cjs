const fs = require('fs')
const os = require('os')
const path = require('path')
const AdmZip = require('adm-zip')
const { Worker } = require('worker_threads')
const { prepareMangaModel, prepareMetadataModel } = require('../../modules/database.js')

const marker = 'VERSION2\nFixture title\n123456\nabcdef1234\n'
const archive = (entries, comment = '') => {
  const zip = new AdmZip()
  for (const [filename, content] of Object.entries(entries)) zip.addFile(filename, Buffer.from(content))
  zip.addZipComment(comment)
  return zip.toBuffer()
}
const createFixture = async descriptors => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'emm-dedupe-v2-'))
  const library = path.join(root, 'Library')
  const databasePath = path.join(root, 'database.sqlite'), metadataPath = path.join(root, 'metadata.sqlite')
  await fs.promises.mkdir(library)
  const Manga = prepareMangaModel(databasePath), Metadata = prepareMetadataModel(metadataPath)
  await Promise.all([Manga.sync(), Metadata.sync()])
  for (const descriptor of descriptors) {
    const filepath = path.join(library, descriptor.filename || descriptor.id + (descriptor.type === 'folder' ? '' : '.zip'))
    if (descriptor.type === 'folder') {
      await fs.promises.mkdir(filepath, { recursive: true })
      for (const [name, content] of Object.entries(descriptor.entries || {})) {
        await fs.promises.mkdir(path.dirname(path.join(filepath, name)), { recursive: true })
        await fs.promises.writeFile(path.join(filepath, name), content)
      }
    } else await fs.promises.writeFile(filepath, descriptor.buffer || archive(descriptor.entries || { '001.jpg': 'first', '002.jpg': 'second', '.ehviewer': marker }, descriptor.comment))
    const stat = await fs.promises.stat(filepath)
    const book = { id: descriptor.id, title: descriptor.title || 'Fixture edition', hash: descriptor.hash === null ? null : descriptor.hash || 'sample-' + descriptor.id,
      coverPath: descriptor.coverPath || '',
      filepath, type: descriptor.type || 'zip', bundleSize: stat.size, mtime: stat.mtime.toISOString(),
      url: descriptor.url === undefined ? 'https://exhentai.org/g/123456/abcdef1234/' : descriptor.url,
      status: 'tagged', tags: descriptor.tags || { artist: ['fixture-artist'], language: ['japanese'] },
      readCount: descriptor.readCount || 0, mark: Boolean(descriptor.mark), hiddenBook: Boolean(descriptor.hiddenBook) }
    await Manga.create(book)
    if (book.hash) await Metadata.create(Object.fromEntries(Object.keys(Metadata.rawAttributes).filter(key => book[key] !== undefined).map(key => [key, book[key]])))
  }
  return { root, library, databasePath, metadataPath, Manga, Metadata, auditStorePath: path.join(root, 'audit'),
    cleanup: async () => { await Promise.all([Manga.sequelize.close(), Metadata.sequelize.close()]); await fs.promises.rm(root, { recursive: true, force: true }) } }
}
const scan = async (fixture, options = {}, jobId = 'scan-' + Date.now()) => {
  const jobDir = path.join(fixture.auditStorePath, 'jobs', 'dedupe', jobId)
  await fs.promises.mkdir(jobDir, { recursive: true })
  await new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, '../../modules/audit/dedupe_worker.js'), { workerData: { jobId, jobDir,
      options: { library: fixture.library, databasePath: fixture.databasePath, metadataPath: fixture.metadataPath, auditStorePath: fixture.auditStorePath, ...options } } })
    let result
    worker.on('message', message => { if (message.type === 'completed') result = message; if (message.type === 'failed') reject(new Error(message.error)) })
    worker.on('error', reject)
    worker.on('exit', code => code || !result ? reject(new Error('Dedupe fixture scan failed')) : resolve(result))
  })
  return JSON.parse(await fs.promises.readFile(path.join(jobDir, 'report.json'), 'utf8'))
}
module.exports = { archive, marker, createFixture, scan }
