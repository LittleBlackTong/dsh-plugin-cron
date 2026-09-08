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
}

export interface CronStore {
  list(): CronJob[]
  get(id: string): CronJob | undefined
  create(job: Omit<CronJob, 'id' | 'createdAt'>): CronJob
  update(id: string, patch: Partial<Omit<CronJob, 'id' | 'createdAt'>>): CronJob
  delete(id: string): boolean
  watch(callback: (jobs: CronJob[]) => void): () => void
}
