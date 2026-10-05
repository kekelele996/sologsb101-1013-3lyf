/**
 * 巡护队 store：管作业报备单、批准站位、禁入期，以及普查队同步过来的对账台账与重试队列。
 * 所有表都在巡护库 gbcoralpatrol，不写普查库；批准 / 撤销等动作通过 utils/reconcile 触发普查侧重判。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { createId, patrolDb, watchPatrolTable } from '@/utils/patrolDb'
import type { Filing, FilingStatus } from '@/types/filing'
import { filingKeyOf, nextFilingNo } from '@/types/filing'
import type { Closure } from '@/types/closure'
import { nextClosureNo } from '@/types/closure'
import type { ReconcileLedgerEntry, ReconcileOutboxTask } from '@/types/clearance'
import { readjudgeAfterClosure, readjudgeAfterFiling } from '@/utils/reconcile'

export type NewFilingInput = Omit<
  Filing,
  'id' | 'no' | 'createdAt' | 'updatedAt' | 'status' | 'source' | 'reviewer'
>

export const usePatrolStore = defineStore('patrol', () => {
  const filings = ref<Filing[]>([])
  const closures = ref<Closure[]>([])
  const ledger = ref<ReconcileLedgerEntry[]>([])
  const outbox = ref<ReconcileOutboxTask[]>([])
  const ready = ref(false)
  const busy = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchPatrolTable<Filing>(() => patrolDb.filings).subscribe((rows) => {
      filings.value = rows.sort((a, b) => b.updatedAt - a.updatedAt)
      ready.value = true
    })
    watchPatrolTable<Closure>(() => patrolDb.closures).subscribe((rows) => {
      closures.value = rows.sort((a, b) => b.updatedAt - a.updatedAt)
    })
    watchPatrolTable<ReconcileLedgerEntry>(() => patrolDb.reconcileLedger).subscribe((rows) => {
      ledger.value = rows.sort((a, b) => b.reconciledAt - a.reconciledAt)
    })
    watchPatrolTable<ReconcileOutboxTask>(() => patrolDb.outbox).subscribe((rows) => {
      outbox.value = rows.sort((a, b) => b.updatedAt - a.updatedAt)
    })
  }

  /* ------------------------------- 报备单 ------------------------------- */

  /** 批准站位视图：已批准报备按对账键去重后即「当前批准的作业站位 + 日期」 */
  const approvedSites = computed(() => {
    const map = new Map<string, Filing>()
    filings.value
      .filter((filing) => filing.status === 'approved')
      .forEach((filing) => map.set(filingKeyOf(filing), filing))
    return Array.from(map.values()).sort((a, b) =>
      b.surveyDate === a.surveyDate
        ? a.reefName.localeCompare(b.reefName, 'zh-Hans-CN')
        : b.surveyDate.localeCompare(a.surveyDate)
    )
  })

  const filingStats = computed(() => ({
    total: filings.value.length,
    approved: filings.value.filter((filing) => filing.status === 'approved').length,
    verifying: filings.value.filter((filing) => filing.status === 'verifying').length,
    rejected: filings.value.filter((filing) => filing.status === 'rejected').length
  }))

  const activeClosureCount = computed(() => closures.value.filter((closure) => closure.status === 'active').length)

  function filingsOfKey(reefName: string, siteNo: string, surveyDate: string): Filing[] {
    return filings.value.filter((filing) => filingKeyOf(filing) === `${reefName.trim()}::${siteNo.trim()}::${surveyDate.trim()}`)
  }

  /** 登记报备（普查队下水前报备 / 挂起后补报共用）；已存在同键待核或拒绝件时返回冲突提示 */
  async function registerFiling(
    input: NewFilingInput,
    options: { source?: Filing['source']; id?: string; createdAt?: number } = {}
  ): Promise<{ filing: Filing; duplicated: boolean }> {
    const now = Date.now()
    const existing = filingsOfKey(input.reefName, input.siteNo, input.surveyDate)
    const approved = existing.find((filing) => filing.status === 'approved')
    if (approved) {
      return { filing: approved, duplicated: true }
    }
    const filing: Filing = {
      ...input,
      id: options.id ?? createId('filing'),
      no: nextFilingNo(input.surveyDate, input.siteNo),
      status: 'verifying',
      source: options.source ?? 'normal',
      reviewer: '',
      createdAt: options.createdAt ?? now,
      updatedAt: now
    }
    await patrolDb.filings.put(filing)
    return { filing, duplicated: false }
  }

  /**
   * 巡护队审核报备：
   * - approved（含补报通过）：自动重判该站位当天先前挂起的样带，符合条件即放行；
   * - rejected：不触发放行重判（没有新批准件，样带维持原挂起结论）。
   */
  async function reviewFiling(
    id: string,
    status: Extract<FilingStatus, 'approved' | 'rejected'>,
    reviewer: string
  ): Promise<{ reviewed: boolean; released: number; held: number }> {
    const filing = await patrolDb.filings.get(id)
    if (!filing) return { reviewed: false, released: 0, held: 0 }
    await patrolDb.filings.update(id, {
      status,
      reviewer: reviewer.trim() || '巡护队',
      updatedAt: Date.now()
    } as never)
    if (status === 'rejected') {
      return { reviewed: true, released: 0, held: 0 }
    }
    const updated = { ...filing, status, reviewer: reviewer.trim() || '巡护队' }
    const result = await readjudgeAfterFiling(updated)
    return { reviewed: true, released: result.released, held: result.held }
  }

  /* ------------------------------- 禁入期 ------------------------------- */

  async function createClosure(
    input: Omit<
      Closure,
      'id' | 'no' | 'createdAt' | 'updatedAt' | 'status' | 'revokedBy' | 'revokedAt' | 'revokeNote'
    >
  ): Promise<Closure> {
    const now = Date.now()
    const closure: Closure = {
      ...input,
      id: createId('closure'),
      no: nextClosureNo(input.startDate),
      status: 'active',
      revokedBy: '',
      revokedAt: null,
      revokeNote: '',
      createdAt: now,
      updatedAt: now
    }
    await patrolDb.closures.put(closure)
    return closure
  }

  /**
   * 撤销禁入期：只改状态留档，不删除通告；撤销后先前因此挂起的样带自动重新判定。
   */
  async function revokeClosure(id: string, operator: string, note: string): Promise<{ revoked: boolean; released: number; held: number }> {
    const closure = await patrolDb.closures.get(id)
    if (!closure || closure.status !== 'active') return { revoked: false, released: 0, held: 0 }
    const now = Date.now()
    const updated: Closure = {
      ...closure,
      status: 'revoked',
      revokedBy: operator.trim() || '巡护队',
      revokedAt: now,
      revokeNote: note.trim(),
      updatedAt: now
    }
    await patrolDb.closures.put(updated)
    const result = await readjudgeAfterClosure(updated)
    return { revoked: true, released: result.released, held: result.held }
  }

  return {
    filings,
    closures,
    ledger,
    outbox,
    ready,
    busy,
    approvedSites,
    filingStats,
    activeClosureCount,
    start,
    filingsOfKey,
    registerFiling,
    reviewFiling,
    createClosure,
    revokeClosure
  }
})
