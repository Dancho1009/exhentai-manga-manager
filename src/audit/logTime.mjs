const beijingFormatter = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
})

export const formatBeijingLogTime = value => {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? beijingFormatter.format(date) : '-'
}

export const compareLogTimes = (left, right) => (Date.parse(left.at) || 0) - (Date.parse(right.at) || 0)
