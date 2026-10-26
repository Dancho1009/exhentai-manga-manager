const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeAiJsonText } = require('../modules/ai_json_parser.js')

test('AI JSON normalization accepts raw JSON and a complete markdown fence', () => {
  assert.deepEqual(normalizeAiJsonText('\uFEFF  {"ok":true}  '), { text: '{"ok":true}', envelope: 'raw_json' })
  assert.deepEqual(normalizeAiJsonText('```json\r\n{"ok":true}\r\n```'), { text: '{"ok":true}', envelope: 'markdown_fence' })
  assert.deepEqual(normalizeAiJsonText('```\n{"ok":true}\n```'), { text: '{"ok":true}', envelope: 'markdown_fence' })
})

test('AI JSON normalization does not hide prose or repair malformed JSON', () => {
  const prose = normalizeAiJsonText('Here is the result:\n{"ok":true}')
  assert.throws(() => JSON.parse(prose.text), SyntaxError)
  const malformed = normalizeAiJsonText('```json\n{"message":"bad "quote"}\n```')
  assert.throws(() => JSON.parse(malformed.text), SyntaxError)
})
