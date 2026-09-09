export type RunStatus = 'success' | 'failed' | 'skipped'

export interface CronJob {
  id: string
  name: string
  schedule: string
  prompt: string
  sessionStrategy: 'new' | 'fixed'
  fixedSessionId?: string
  enabled: boolean
  createdAt: number
  lastRunAt?: number
  nextRunAt?: number
  skippedAt?: number
  // v0.2 run tracking
  lastRunStatus?: RunStatus
  lastRunError?: string
  runCount: number
}

export interface CronStore {
  list(): CronJob[]
  get(id: string): CronJob | undefined
  create(job: Omit<CronJob, 'id' | 'createdAt' | 'lastRunAt' | 'nextRunAt' | 'skippedAt' | 'lastRunStatus' | 'lastRunError' | 'runCount'>): CronJob
  update(id: string, patch: Partial<Omit<CronJob, 'id' | 'createdAt' | 'lastRunAt' | 'lastRunStatus' | 'lastRunError' | 'runCount'>>): CronJob
  delete(id: string): boolean
  recordRun(id: string, outcome: { status: RunStatus; error?: string }): boolean
  touch(id: string, fields: Partial<CronJob>): boolean
  watch(callback: (jobs: CronJob[]) => void): () => void
}
