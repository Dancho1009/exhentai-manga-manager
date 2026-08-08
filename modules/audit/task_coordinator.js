class LibraryTaskCoordinator {
  constructor() {
    this.auditJobId = null
    this.mutations = new Set()
  }

  createBusyError(message = 'Library is busy') {
    const error = new Error(message)
    error.code = 'LIBRARY_TASK_BUSY'
    return error
  }

  beginAudit(jobId) {
    if (this.auditJobId || this.mutations.size > 0) {
      throw this.createBusyError('A library task is already running')
    }
    this.auditJobId = jobId
  }

  endAudit(jobId) {
    if (!jobId || this.auditJobId === jobId) this.auditJobId = null
  }

  assertWritable(owner) {
    if (this.auditJobId && owner !== this.auditJobId) {
      const error = new Error('LIBRARY_AUDIT_LOCKED')
      error.code = 'LIBRARY_AUDIT_LOCKED'
      throw error
    }
  }

  async runMutation(label, task, owner) {
    this.assertWritable(owner)
    const token = `${label}:${Date.now()}:${Math.random()}`
    this.mutations.add(token)
    try {
      return await task()
    } finally {
      this.mutations.delete(token)
    }
  }

  getState() {
    return {
      auditRunning: Boolean(this.auditJobId),
      auditJobId: this.auditJobId,
      mutationCount: this.mutations.size
    }
  }
}

module.exports = { LibraryTaskCoordinator }
