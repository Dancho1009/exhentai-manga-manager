const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const { enumerateBookEntries } = require('../modules/audit/dedupe_manifest.js')
const { inspectBookContent } = require('../modules/audit/archive_inspector.js')
const { hashFile } = require('../modules/audit/utils.js')
const { runPreview } = require('../modules/audit/dedupe_preview_worker.js')

const run = async () => {
  const library = process.argv[2], output = path.resolve(process.argv[3])
  const directories = [library]
  for (const entry of await fs.promises.readdir(library, { withFileTypes: true })) if (entry.isDirectory() && !entry.name.startsWith('.')) directories.push(path.join(library, entry.name))
  let sample
  for (const directory of directories.slice(0, 8)) {
    const entries = await fs.promises.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !/\.(zip|cbz)$/i.test(entry.name)) continue
      const filepath = path.join(directory, entry.name)
      const stat = await fs.promises.stat(filepath)
      if (stat.size > 20 * 1024 * 1024) continue
      sample = { filepath, type: 'zip', stat }; break
    }
    if (sample) break
  }
  if (!sample) throw new Error('No small NAS ZIP sample available')
  const result = { filepath: sample.filepath, archiveBytes: sample.stat.size, measurementOrder: 'manifest -> archive hash -> page hash -> selected preview', measurements: {} }
  const measure = async (name, work) => { const begin = performance.now(); const value = await work(); result.measurements[name] = { elapsedMs: Math.round(performance.now() - begin) }; return value }
  const manifestIo = {}, contentIo = {}
  const manifest = await measure('manifest', () => enumerateBookEntries(sample, { ioStats: manifestIo }))
  result.measurements.manifest.io = manifestIo
  await measure('archiveHash', () => hashFile(sample.filepath))
  result.measurements.archiveHash.hashBytes = sample.stat.size
  const inspection = await measure('content', () => inspectBookContent(sample, { manifest, ioStats: contentIo }))
  result.measurements.content.io = contentIo
  result.measurements.content.hashBytes = [...inspection.images, ...inspection.ancillary].reduce((sum, entry) => sum + entry.size, 0)
  result.pageCount = inspection.pageCount
  const previewRoot = path.join(path.dirname(output), 'nas-dedupe-preview')
  const preview = await measure('selectedPreview', () => runPreview({ entries: inspection.images.slice(0, 2).map((entry, index) => ({ key: 'page-' + index, book: sample, entry })), outputDir: previewRoot, cancelBuffer: new SharedArrayBuffer(4) }))
  result.measurements.selectedPreview.entries = preview.length
  result.measurements.selectedPreview.errors = preview.filter(item => item.error).map(item => item.error)
  const after = await fs.promises.stat(sample.filepath)
  result.sourceUnchanged = after.size === sample.stat.size && after.mtimeMs === sample.stat.mtimeMs
  await fs.promises.writeFile(output, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
}
run().catch(error => { console.error(error); process.exitCode = 1 })
