const fs = require('fs')

const VERSION2_HEADER = 'VERSION2'
const CBOR_BREAK = Symbol('cbor-break')

const stripBom = (buffer) => {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.slice(3)
  }
  return buffer
}

const isVersion2Buffer = (buffer) => {
  const body = stripBom(buffer)
  return body.length >= VERSION2_HEADER.length && body.slice(0, VERSION2_HEADER.length).toString('utf8') === VERSION2_HEADER
}

const parseVersion2Buffer = (buffer) => {
  const text = stripBom(buffer).toString('utf8')
  const lines = text.split(/\r?\n/)
  if (lines.length < 4) return null
  if (lines[0].trim() !== VERSION2_HEADER) return null

  const gid = lines[2].trim()
  const token = lines[3].trim()
  if (!gid || !token) return null

  return { gid, token }
}

const readUInt = (buffer, offset, length) => {
  switch (length) {
    case 1:
      return { value: buffer.readUInt8(offset), offset: offset + 1 }
    case 2:
      return { value: buffer.readUInt16BE(offset), offset: offset + 2 }
    case 4:
      return { value: buffer.readUInt32BE(offset), offset: offset + 4 }
    case 8: {
      const hi = buffer.readUInt32BE(offset)
      const lo = buffer.readUInt32BE(offset + 4)
      const value = hi * 0x100000000 + lo
      return { value, offset: offset + 8 }
    }
    default:
      throw new Error(`Unsupported integer byte length: ${length}`)
  }
}

const readFloat16 = (buffer, offset) => {
  const half = buffer.readUInt16BE(offset)
  const sign = (half & 0x8000) ? -1 : 1
  const exponent = (half & 0x7C00) >> 10
  const fraction = half & 0x03FF

  if (exponent === 0) {
    if (fraction === 0) return { value: sign * 0, offset: offset + 2 }
    return { value: sign * Math.pow(2, -14) * (fraction / 1024), offset: offset + 2 }
  }

  if (exponent === 0x1F) {
    if (fraction === 0) return { value: sign * Infinity, offset: offset + 2 }
    return { value: NaN, offset: offset + 2 }
  }

  return { value: sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024), offset: offset + 2 }
}

const readCborLength = (buffer, offset, ai) => {
  if (ai < 24) return { length: ai, offset }
  if (ai === 24) return readUInt(buffer, offset, 1)
  if (ai === 25) return readUInt(buffer, offset, 2)
  if (ai === 26) return readUInt(buffer, offset, 4)
  if (ai === 27) return readUInt(buffer, offset, 8)
  if (ai === 31) return { length: null, offset }
  throw new Error(`Unsupported CBOR additional info: ${ai}`)
}

const decodeCbor = (buffer, offset = 0) => {
  if (offset >= buffer.length) {
    throw new Error('Unexpected end of CBOR data')
  }

  const initialByte = buffer[offset]
  if (initialByte === 0xFF) {
    return { value: CBOR_BREAK, offset: offset + 1 }
  }

  const majorType = initialByte >> 5
  const ai = initialByte & 0x1F
  offset += 1

  if (majorType === 0) {
    const { value, offset: nextOffset } = readCborLength(buffer, offset, ai)
    return { value, offset: nextOffset }
  }

  if (majorType === 1) {
    const { value, offset: nextOffset } = readCborLength(buffer, offset, ai)
    return { value: -1 - value, offset: nextOffset }
  }

  if (majorType === 2) {
    const { length, offset: nextOffset } = readCborLength(buffer, offset, ai)
    if (length === null) {
      const chunks = []
      let cursor = nextOffset
      while (true) {
        const chunk = decodeCbor(buffer, cursor)
        cursor = chunk.offset
        if (chunk.value === CBOR_BREAK) break
        if (!Buffer.isBuffer(chunk.value)) throw new Error('Invalid CBOR byte string chunk')
        chunks.push(chunk.value)
      }
      return { value: Buffer.concat(chunks), offset: cursor }
    }
    const end = nextOffset + length
    if (end > buffer.length) throw new Error('Unexpected end of CBOR byte string')
    return { value: buffer.slice(nextOffset, end), offset: end }
  }

  if (majorType === 3) {
    const { length, offset: nextOffset } = readCborLength(buffer, offset, ai)
    if (length === null) {
      let cursor = nextOffset
      let result = ''
      while (true) {
        const chunk = decodeCbor(buffer, cursor)
        cursor = chunk.offset
        if (chunk.value === CBOR_BREAK) break
        if (typeof chunk.value !== 'string') throw new Error('Invalid CBOR text string chunk')
        result += chunk.value
      }
      return { value: result, offset: cursor }
    }
    const end = nextOffset + length
    if (end > buffer.length) throw new Error('Unexpected end of CBOR text string')
    return { value: buffer.toString('utf8', nextOffset, end), offset: end }
  }

  if (majorType === 4) {
    const { length, offset: nextOffset } = readCborLength(buffer, offset, ai)
    const items = []
    let cursor = nextOffset
    if (length === null) {
      while (true) {
        const item = decodeCbor(buffer, cursor)
        cursor = item.offset
        if (item.value === CBOR_BREAK) break
        items.push(item.value)
      }
      return { value: items, offset: cursor }
    }
    for (let index = 0; index < length; index += 1) {
      const item = decodeCbor(buffer, cursor)
      cursor = item.offset
      items.push(item.value)
    }
    return { value: items, offset: cursor }
  }

  if (majorType === 5) {
    const { length, offset: nextOffset } = readCborLength(buffer, offset, ai)
    const result = {}
    let cursor = nextOffset
    if (length === null) {
      while (true) {
        const key = decodeCbor(buffer, cursor)
        cursor = key.offset
        if (key.value === CBOR_BREAK) break
        const value = decodeCbor(buffer, cursor)
        cursor = value.offset
        result[String(key.value)] = value.value
      }
      return { value: result, offset: cursor }
    }
    for (let index = 0; index < length; index += 1) {
      const key = decodeCbor(buffer, cursor)
      cursor = key.offset
      const value = decodeCbor(buffer, cursor)
      cursor = value.offset
      result[String(key.value)] = value.value
    }
    return { value: result, offset: cursor }
  }

  if (majorType === 6) {
    const { length: tag, offset: nextOffset } = readCborLength(buffer, offset, ai)
    const value = decodeCbor(buffer, nextOffset)
    return { value: value.value, offset: value.offset }
  }

  if (majorType === 7) {
    if (ai === 20) return { value: false, offset }
    if (ai === 21) return { value: true, offset }
    if (ai === 22) return { value: null, offset }
    if (ai === 23) return { value: undefined, offset }
    if (ai === 24) return { value: buffer.readUInt8(offset), offset: offset + 1 }
    if (ai === 25) return readFloat16(buffer, offset)
    if (ai === 26) return { value: buffer.readFloatBE(offset), offset: offset + 4 }
    if (ai === 27) return { value: buffer.readDoubleBE(offset), offset: offset + 8 }
    if (ai === 31) return { value: CBOR_BREAK, offset }
  }

  throw new Error(`Unsupported CBOR major type: ${majorType}`)
}

const readEhviewerBuffer = (buffer) => {
  try {
    if (!Buffer.isBuffer(buffer)) {
      buffer = Buffer.from(buffer)
    }
    if (buffer.length === 0) return null

    if (isVersion2Buffer(buffer)) {
      return parseVersion2Buffer(buffer)
    }

    const decoded = decodeCbor(buffer)
    const data = decoded.value
    if (!data || typeof data !== 'object') return null

    const gid = data.gid
    const token = data.token
    if (gid === undefined || token === undefined || gid === null || token === null) return null

    return { gid: String(gid), token: String(token) }
  } catch (error) {
    return null
  }
}

const readEhviewerFile = async (filePath) => {
  try {
    const buffer = await fs.promises.readFile(filePath)
    return readEhviewerBuffer(buffer)
  } catch (error) {
    return null
  }
}

module.exports = {
  readEhviewerBuffer,
  readEhviewerFile
}
