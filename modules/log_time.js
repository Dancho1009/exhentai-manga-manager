const beijingLogTimestamp = (value = Date.now()) => new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000)
  .toISOString().replace(/Z$/, '+08:00')

module.exports = { beijingLogTimestamp }
