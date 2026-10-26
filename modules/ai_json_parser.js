// Normalize only the response envelope that compatible upstreams commonly add
// around an otherwise valid JSON object. The JSON body itself remains strict.
const normalizeAiJsonText = value => {
  const source = typeof value === 'string' ? value.replace(/^\uFEFF/, '').trim() : ''
  const match = source.match(/^```(?:json)?[ \t]*(?:\r?\n)?([\s\S]*?)(?:\r?\n)?```$/i)
  return {
    text: (match ? match[1] : source).trim(),
    envelope: match ? 'markdown_fence' : 'raw_json'
  }
}

module.exports = { normalizeAiJsonText }
