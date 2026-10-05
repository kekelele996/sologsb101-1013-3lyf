/**
 * 巡护队 store：维护作业报备单、批准站位与禁入期，并承担与普查队样带的对账。
 * 巡护队侧写入与普查队样带写入分离：样带由普查队录入，报备单由本侧登记；
 * 写入失败时只重试巡护队一侧（普查队样带已落库，不重复写入）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { db, createId, watchTable } from '@/utils/db'
import type { Belt } from '@/types/belt'
import type {
  NewNoEntryPeriod,
  NewPatrolReport,
  NoEntryPeriod,
  PatrolReport,
  ReportStatus
} from '@/types/patrol'
import { judgeBeltReport } from '@/utils/reconcile'

/** 单侧写入结果 */
export interface SyncResult {
  ok: boolean
  error?: string
}

export const usePatrolStore = defineStore('patrol', () => {
  const reports = ref<PatrolReport[]>([])
  const noEntryPeriods = ref<NoEntryPeriod[]>([])
  const ready = ref(false)
  /** 演练开关：模拟巡护队侧写入失败，用于演示「只重试巡护队一侧」 */
  const simulateWriteFailure = ref(false)

  let started = false

  function start(): void {
    if (started) return
    started = true
    watchTable<PatrolReport>(() => db.patrolReports).subscribe((rows) => {
      reports.value = rows
      ready.value = true
    })
    watchTable<NoEntryPeriod>(() => db.noEntryPeriods).subscribe((rows) => {
      noEntryPeriods.value = rows
    })
  }

  /** 已批准站位编号集合（持有已批准报备单的站位） */
  const approvedStationNos = computed<Set<string>>(
    () => new Set(reports.value.filter((report) => report.status === '已批准').map((report) => report.stationNo))
  )

  function nextReportNo(): string {
    const nums = reports.value
      .map((report) => Number(report.reportNo.replace(/[^0-9]/g, '')))
      .filter((value) => Number.isFinite(value))
    const next = nums.length === 0 ? 1 : Math.max(...nums) + 1
    return `BB-${String(next).padStart(3, '0')}`
  }

  /* ------------------------------ 报备单 ------------------------------ */

  async function createReport(payload: NewPatrolReport): Promise<PatrolReport> {
    const now = Date.now()
    const row: PatrolReport = { ...payload, id: createId('rpt'), createdAt: now, updatedAt: now }
    await db.patrolReports.put(row)
    return row
  }

  async function setReportStatus(id: string, status: ReportStatus): Promise<void> {
    await db.patrolReports.update(id, { status, updatedAt: Date.now() } as never)
    await reconcileAll()
  }

  async function removeReport(id: string): Promise<void> {
    await db.patrolReports.delete(id)
    await reconcileAll()
  }

  /* ------------------------------ 禁入期 ------------------------------ */

  async function createNoEntryPeriod(payload: NewNoEntryPeriod): Promise<NoEntryPeriod> {
    const now = Date.now()
    const row: NoEntryPeriod = { ...payload, id: createId('ne'), createdAt: now, updatedAt: now }
    await db.noEntryPeriods.put(row)
    await reconcileAll()
    return row
  }

  /** 撤销禁入期：先前因禁入期挂起的样带重新判定 */
  async function revokeNoEntryPeriod(id: string): Promise<void> {
    await db.noEntryPeriods.update(id, { revoked: true, updatedAt: Date.now() } as never)
    await reconcileAll()
  }

  async function removeNoEntryPeriod(id: string): Promise<void> {
    await db.noEntryPeriods.delete(id)
    await reconcileAll()
  }

  /* ------------------------------ 巡护队侧写入与重试 ------------------------------ */

  /**
   * 巡护队侧写入：为普查队新录入的样带登记（或链入）一张待核报备单。
   * 与普查队样带写入分离，失败时抛出，由调用方标记样带「巡护队侧待重试」。
   */
  async function registerBeltToPatrol(belt: Belt, stationNo: string): Promise<PatrolReport> {
    if (simulateWriteFailure.value) {
      throw new Error('巡护队侧写入失败（演练）：报备单未落库')
    }
    const existing = reports.value.find(
      (report) => report.stationNo === stationNo && report.workDate === belt.surveyDate
    )
    if (existing) return existing
    return createReport({
      reportNo: nextReportNo(),
      stationNo,
      workDate: belt.surveyDate,
      status: '待核',
      remark: `普查队样带 ${belt.no} 录入后自动报备`
    })
  }

  /** 判定时使用的报备单列表：确保刚写入的报备单也参与判定 */
  function reportsWith(extra: PatrolReport): PatrolReport[] {
    const map = new Map<string, PatrolReport>()
    reports.value.forEach((report) => map.set(report.id, report))
    map.set(extra.id, extra)
    return Array.from(map.values())
  }

  /**
   * 把单条样带同步到巡护队并回写对账结论。
   * 普查队样带已落库，这里只做巡护队侧写入 + 样带对账状态回写；
   * 重试时同样只走这里，不重复创建普查队样带。
   */
  async function syncOne(belt: Belt, stationNo: string): Promise<SyncResult> {
    try {
      const report = await registerBeltToPatrol(belt, stationNo)
      const verdict = judgeBeltReport(belt, stationNo, reportsWith(report), noEntryPeriods.value)
      await db.belts.update(belt.id, {
        reportId: report.id,
        syncedToPatrol: true,
        reportState: verdict.state,
        suspendReason: verdict.reason,
        updatedAt: Date.now()
      } as never)
      return { ok: true }
    } catch (error) {
      await db.belts.update(belt.id, {
        syncedToPatrol: false,
        reportState: '待核',
        suspendReason: '巡护队侧写入失败，待重试',
        updatedAt: Date.now()
      } as never)
      return { ok: false, error: error instanceof Error ? error.message : '巡护队侧写入失败' }
    }
  }

  /** 只重试巡护队一侧：不重写普查队样带，仅补报备登记并回写状态 */
  async function retryPatrolSync(belt: Belt, stationNo: string): Promise<SyncResult> {
    return syncOne(belt, stationNo)
  }

  /**
   * 补报：为挂起样带补一张报备单（待核），补报通过后放行。
   * 补报单核准后由 setReportStatus 触发重新对账。
   */
  async function supplementaryReport(belt: Belt, stationNo: string): Promise<PatrolReport> {
    const report = await createReport({
      reportNo: nextReportNo(),
      stationNo,
      workDate: belt.surveyDate,
      status: '待核',
      remark: `样带 ${belt.no} 挂起后补报`
    })
    await reconcileAll()
    return report
  }

  /* ------------------------------ 全量对账 ------------------------------ */

  /**
   * 全量对账：按站位编号重新判定所有样带并回写报备状态。
   * 返回状态发生变化的样带条数。
   */
  async function reconcileAll(): Promise<number> {
    const [belts, sites] = await Promise.all([db.belts.toArray(), db.sites.toArray()])
    const siteNoById = new Map(sites.map((site) => [site.id, site.no]))
    let changed = 0
    await db.transaction('rw', [db.belts], async () => {
      for (const belt of belts) {
        const stationNo = siteNoById.get(belt.siteId) ?? ''
        const verdict = judgeBeltReport(belt, stationNo, reports.value, noEntryPeriods.value)
        const patch: Partial<Belt> = {}
        if (belt.reportState !== verdict.state) patch.reportState = verdict.state
        if (belt.suspendReason !== verdict.reason) patch.suspendReason = verdict.reason
        if (belt.reportId !== verdict.reportId) patch.reportId = verdict.reportId
        if (Object.keys(patch).length > 0) {
          patch.updatedAt = Date.now()
          await db.belts.update(belt.id, patch as never)
          changed += 1
        }
      }
    })
    return changed
  }

  return {
    reports,
    noEntryPeriods,
    ready,
    simulateWriteFailure,
    approvedStationNos,
    start,
    nextReportNo,
    createReport,
    setReportStatus,
    removeReport,
    createNoEntryPeriod,
    revokeNoEntryPeriod,
    removeNoEntryPeriod,
    registerBeltToPatrol,
    syncOne,
    retryPatrolSync,
    supplementaryReport,
    reconcileAll
  }
})
