const returnTrimFileName = (book = {}, setting = {}) => {
  const filepath = String(book.filepath || '')
  const fileNameWithExtension = filepath.split(/[/\\]/).pop() || ''
  let fileNameWithoutExtension = fileNameWithExtension
  try {
    if (book.type !== 'folder') {
      fileNameWithoutExtension = fileNameWithExtension.split('.').slice(0, -1).join('.')
    }
    if (setting.trimTitleRegExp) {
      fileNameWithoutExtension = fileNameWithoutExtension.replace(new RegExp(setting.trimTitleRegExp, 'g'), '')
    }
    if (setting.searchKeySuffix) {
      fileNameWithoutExtension = fileNameWithoutExtension + ' ' + setting.searchKeySuffix
    }
  } catch (error) {
    console.log(error)
  }
  return fileNameWithoutExtension
}

module.exports = { returnTrimFileName }
