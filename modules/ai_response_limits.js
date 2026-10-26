// Protocol envelopes and streamed event metadata are not model output.
const MAX_STREAM_BYTES = 32 * 1024 * 1024
const MAX_CONTENT_BYTES = 1024 * 1024
const responseLimit = (kind, bytes) => {
  const limitBytes = kind === 'content' ? MAX_CONTENT_BYTES : MAX_STREAM_BYTES
  if (bytes <= limitBytes) return
  throw Object.assign(new Error(`AI ${kind === 'content' ? '结果正文' : '响应传输'}超过 ${limitBytes / 1024 / 1024} MiB 限制。`), {
    code: 'AI_RESPONSE_TOO_LARGE', limitKind: kind, limitBytes, receivedBytes: bytes
  })
}
module.exports = { MAX_STREAM_BYTES, MAX_CONTENT_BYTES, responseLimit }
