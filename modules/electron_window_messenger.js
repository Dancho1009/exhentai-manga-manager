const DISPOSED_FRAME_PATTERN = /Render frame was disposed|WebContents is destroyed|Object has been destroyed|RenderProcessGone/i

const isDisposedFrameError = error => DISPOSED_FRAME_PATTERN.test(String(error?.message || error || ''))

const frameAvailable = win => {
  if (!win || win.isDestroyed?.()) return false
  const contents = win.webContents
  if (!contents || contents.isDestroyed?.()) return false
  try {
    if (contents.isLoadingMainFrame?.()) return false
    const frame = contents.mainFrame
    if (frame?.isDestroyed?.()) return false
  } catch {
    return false
  }
  return true
}

const safeSend = (win, channel, ...args) => {
  if (!frameAvailable(win)) return false
  try {
    win.webContents.send(channel, ...args)
    return true
  } catch (error) {
    if (isDisposedFrameError(error)) return false
    return false
  }
}

const createWindowMessenger = ({ getWindow, onError = () => {} } = {}) => {
  let ready = false
  let disposed = false
  const pending = new Map()

  const send = (channel, ...args) => {
    if (disposed) return false
    const win = getWindow?.()
    if (!ready || !frameAvailable(win)) {
      pending.set(channel, args)
      return false
    }
    try {
      win.webContents.send(channel, ...args)
      return true
    } catch (error) {
      pending.set(channel, args)
      if (!isDisposedFrameError(error)) onError(error, channel)
      ready = false
      return false
    }
  }

  const flush = () => {
    if (disposed || !ready) return
    for (const [channel, args] of pending) {
      if (!send(channel, ...args)) break
      pending.delete(channel)
    }
  }

  return {
    send,
    markLoading() { ready = false },
    markReady() { disposed = false; ready = true; flush() },
    dispose() { disposed = true; ready = false; pending.clear() },
    isReady() { return ready && !disposed },
    pendingChannels() { return [...pending.keys()] }
  }
}

module.exports = { createWindowMessenger, frameAvailable, isDisposedFrameError, safeSend }
