const fs = require('fs')
const yauzl = require('yauzl')

const ZIP_READ_BLOCK_SIZE = 256 * 1024
const ZIP_READ_CACHE_BLOCKS = 4

class BufferedZipReader extends yauzl.RandomAccessReader {
  constructor(handle, size, { blockSize = ZIP_READ_BLOCK_SIZE, maxBlocks = ZIP_READ_CACHE_BLOCKS, ioStats } = {}) {
    super()
    this.handle = handle
    this.size = size
    this.blockSize = blockSize
    this.maxBlocks = maxBlocks
    this.blocks = new Map()
    this.ioStats = ioStats
  }

  readFile(buffer, offset, length, position, callback) {
    if (this.ioStats) this.ioStats.readCalls = (this.ioStats.readCalls || 0) + 1
    fs.read(this.handle.fd, buffer, offset, length, position, (error, bytesRead) => {
      if (this.ioStats) this.ioStats.readBytes = (this.ioStats.readBytes || 0) + (bytesRead || 0)
      callback(error, bytesRead, buffer)
    })
  }

  getBlock(start) {
    let block = this.blocks.get(start)
    if (block) {
      this.blocks.delete(start)
      this.blocks.set(start, block)
      return block
    }
    block = (async () => {
      const buffer = Buffer.allocUnsafe(Math.min(this.blockSize, this.size - start))
      let offset = 0
      while (offset < buffer.length) {
        const bytesRead = await new Promise((resolve, reject) => {
          this.readFile(buffer, offset, buffer.length - offset, start + offset, (error, count) => error ? reject(error) : resolve(count))
        })
        if (!bytesRead) throw new Error('Unexpected EOF while reading ZIP')
        offset += bytesRead
      }
      return buffer
    })()
    this.blocks.set(start, block)
    while (this.blocks.size > this.maxBlocks) this.blocks.delete(this.blocks.keys().next().value)
    return block
  }

  read(buffer, offset, length, position, callback) {
    const copy = async () => {
      const available = Math.min(length, Math.max(0, this.size - position))
      let copied = 0
      while (copied < available) {
        const current = position + copied
        const blockStart = Math.floor(current / this.blockSize) * this.blockSize
        const block = await this.getBlock(blockStart)
        const inBlock = current - blockStart
        const count = Math.min(available - copied, block.length - inBlock)
        block.copy(buffer, offset + copied, inBlock, inBlock + count)
        copied += count
      }
      return copied
    }
    copy().then(count => callback(null, count), callback)
  }

  _readStreamForRange(start, end) {
    // Payloads stay streamed; only small random metadata reads use the block cache.
    return fs.createReadStream('', {
      fd: this.handle.fd,
      autoClose: false,
      start,
      end: end - 1,
      // yauzl destroys range streams after unref. The archive reader owns the
      // shared handle; closing one range must not close the archive descriptor.
      fs: { read: (fd, ...args) => this.readFile(...args), close: (_fd, callback) => callback(null) }
    })
  }

  close(callback) {
    this.blocks.clear()
    this.handle.close().then(() => callback(), callback)
  }
}

const openBufferedZip = async (filepath, options = {}) => {
  const handle = await fs.promises.open(filepath, 'r')
  let reader
  try {
    const stat = await handle.stat()
    reader = new BufferedZipReader(handle, stat.size, options)
    return await new Promise((resolve, reject) => {
      reader.on('error', reject)
      yauzl.fromRandomAccessReader(reader, stat.size, { lazyEntries: true, autoClose: true }, (error, zipfile) => {
        if (error) reject(error)
        else resolve(zipfile)
      })
    })
  } catch (error) {
    if (reader) reader.blocks.clear()
    await handle.close()
    throw error
  }
}

module.exports = { BufferedZipReader, openBufferedZip, ZIP_READ_BLOCK_SIZE, ZIP_READ_CACHE_BLOCKS }
