/**
 * 两队对账域服务。
 * 边界：
 * - 普查队一侧（普查库 gbcoralbelt）：样带、底质、珊瑚覆盖长度，以及对账后写在样带上的 clearance 结论；
 * - 巡护队一侧（巡护库 gbcoralpatrol）：报备单、禁入期、对账台账。
 * 对账动作：录完一批样带后按「礁区 + 站位编号 + 调查日期」判定；
 * 普查侧结论立即生效（挂起样带不进白化汇总），巡护台账异步留底，
 * 台账写失败只重试巡护队一侧（outbox 重放），普查侧不回滚、不重算。
 */
import { db } from '@/utils/db'
import type { Belt } from '@/types/belt'
import type { Site } from '@/types/site'
import type { Reef } from '@/types/reef'
import type { Filing } from '@/types/filing'
import { filingKeyOf } from '@/types/filing'
import type { Closure } from '@/types/closure'
import type {
  ClearanceDecision,
  ClearanceState,
  ReconcileBatchResult,
  ReconcileLedgerEntry,
  ReconcileOutboxTask
} from '@/types/clearance'
import { decideClearance } from '@/utils/clearance'
import { createId, patrolDb, putReconcileLedger } from '@/utils/patrolDb'

/** 保险打开巡护库：深链直达样带页时 bootstrap 可能尚未完成 */
let patrolReady: Promise<void> | null = null
function ensurePatrolReady(): Promise<void> {
  if (!patrolReady) patrolReady = patrolDb.isOpen() ? Promise.resolve() : patrolDb.open().then(() => undefined)
  return patrolReady
}

/** 组装某条样带对账所需的双方快照 */
interface ReconcileContext {
  reefs: Reef[]
  sites: Site[]
  filings: Filing[]
  closures: Closure[]
}

async function loadContext(): Promise<ReconcileContext> {
  const [reefs, sites, filings, closures] = await Promise.all([
    db.reefs.toArray(),
    db.sites.toArray(),
    patrolDb.filings.toArray(),
    patrolDb.closures.toArray()
  ])
  return { reefs, sites, filings, closures }
}

function toClearanceState(decisionResult: ClearanceDecision, reconciledAt: number): ClearanceState {
  return {
    status: decisionResult.status,
    holdReason: decisionResult.holdReason,
    closureNo: decisionResult.closureNo,
    filingNo: decisionResult.filingNo,
    reconciledAt,
    reconcileNote: decisionResult.note
  }
}

function toLedgerEntry(
  belt: Belt,
  context: ReconcileContext,
  decisionResult: ClearanceDecision
): ReconcileLedgerEntry {
  const site = context.sites.find((item) => item.id === belt.siteId)
  const reef = site ? context.reefs.find((item) => item.id === site.reefId) : undefined
  return {
    beltId: belt.id,
    beltNo: belt.no,
    reefName: reef?.name ?? '未知礁区',
    siteNo: site?.no ?? '—',
    surveyDate: belt.surveyDate,
    status: decisionResult.status,
    holdReason: decisionResult.holdReason,
    closureNo: decisionResult.closureNo,
    filingNo: decisionResult.filingNo,
    note: decisionResult.note,
    reconciledAt: belt.clearance?.reconciledAt ?? Date.now()
  }
}

/** 台账写失败：只把巡护队一侧的同步动作放进 outbox，普查结论保持不变 */
async function enqueueLedgerRetry(entry: ReconcileLedgerEntry, error: unknown): Promise<void> {
  const now = Date.now()
  const existing = await patrolDb.outbox.get(entry.beltId)
  const task: ReconcileOutboxTask = {
    id: entry.beltId,
    target: 'reconcileLedger',
    entry,
    attempts: (existing?.attempts ?? 0) + 1,
    lastError: error instanceof Error ? error.message : '巡护台账写入失败',
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  }
  await patrolDb.outbox.put(task)
}

/**
 * 对一批样带执行对账。
 * @param beltIds 指定样带；不传或为空时对全部样带对账
 */
export async function reconcileBelts(beltIds?: string[]): Promise<ReconcileBatchResult> {
  await ensurePatrolReady()
  const context = await loadContext()
  const allBelts = await db.belts.toArray()
  const targets =
    beltIds && beltIds.length > 0 ? allBelts.filter((belt) => beltIds.includes(belt.id)) : allBelts

  const decisions = new Map<string, ClearanceDecision>()
  targets.forEach((belt) => {
    const site = context.sites.find((item) => item.id === belt.siteId)
    const reef = site ? context.reefs.find((item) => item.id === site.reefId) : undefined
    if (!site || !reef) {
      decisions.set(belt.id, {
        status: 'held',
        holdReason: 'unfiled',
        closureNo: null,
        filingNo: null,
        note: '样带缺少站位 / 礁区归属，按无报备挂起'
      })
      return
    }
    decisions.set(
      belt.id,
      decideClearance(
        { reefName: reef.name, siteNo: site.no, surveyDate: belt.surveyDate },
        context.filings,
        context.closures
      )
    )
  })

  // 第一步：普查队一侧写判定结论（这一步是普查数据的权威落库，必须先成功）
  const now = Date.now()
  if (targets.length > 0) {
    await db.transaction('rw', [db.belts], async () => {
      for (const belt of targets) {
        const decisionResult = decisions.get(belt.id)
        if (!decisionResult) continue
        const state = toClearanceState(decisionResult, now)
        await db.belts.update(belt.id, { clearance: state, updatedAt: now } as never)
        belt.clearance = state
      }
    })
  }

  // 第二步：巡护队一侧写对账台账。失败不影响普查结论，只入重试队列（只重试这一侧）
  let ledgerPending = 0
  for (const belt of targets) {
    const decisionResult = decisions.get(belt.id)
    if (!decisionResult) continue
    const entry = toLedgerEntry(belt, context, decisionResult)
    try {
      await putReconcileLedger(entry)
      await patrolDb.outbox.delete(entry.beltId)
    } catch (error) {
      ledgerPending += 1
      await enqueueLedgerRetry(entry, error)
    }
  }

  const resultDecisions = targets.map((belt) => ({
    beltId: belt.id,
    decision: decisions.get(belt.id) as ClearanceDecision
  }))
  return {
    total: targets.length,
    released: resultDecisions.filter((item) => item.decision.status === 'released').length,
    held: resultDecisions.filter((item) => item.decision.status === 'held').length,
    ledgerPending,
    decisions: resultDecisions
  }
}

/**
 * 按站位重判（录完一批样带后的常规对账入口）。
 * @param siteId 站位 id
 */
export async function reconcileSite(siteId: string): Promise<ReconcileBatchResult> {
  const beltIds = (await db.belts.where('siteId').equals(siteId).primaryKeys()) as string[]
  return reconcileBelts(beltIds)
}

/**
 * 巡护队撤销禁入期后：重新判定先前因此挂起的样带。
 * 只重判可能受影响的样带（同礁区、调查日期落在该禁入期窗口内，或当前挂起原因为 closed）。
 */
export async function readjudgeAfterClosure(closure: Closure): Promise<ReconcileBatchResult> {
  const sites = await db.sites.toArray()
  const reefs = await db.reefs.toArray()
  const reef = reefs.find((item) => item.name.trim() === closure.reefName.trim())
  const scopedSiteIds = new Set(
    sites
      .filter((site) => reef && site.reefId === reef.id)
      .map((site) => site.id)
  )
  const allBelts = await db.belts.toArray()
  const affected = allBelts
    .filter((belt) => {
      if (belt.clearance?.status !== 'held') return false
      // 记录了命中该禁入通告号的，一定重判
      if (belt.clearance.closureNo === closure.no) return true
      // 同礁区、日期落在原窗口内的挂起样带也重新判定（可能当时命中的是全礁区通告）
      if (
        scopedSiteIds.has(belt.siteId) &&
        belt.surveyDate >= closure.startDate &&
        belt.surveyDate <= closure.endDate
      ) {
        return true
      }
      return false
    })
    .map((belt) => belt.id)
  return reconcileBelts(affected)
}

/**
 * 报备批准 / 补报通过后：重判该对账键（礁区 + 站位编号 + 日期）下的样带。
 */
export async function readjudgeAfterFiling(filing: Filing): Promise<ReconcileBatchResult> {
  const sites = await db.sites.toArray()
  const reefs = await db.reefs.toArray()
  const reef = reefs.find((item) => item.name.trim() === filing.reefName.trim())
  const site = reef
    ? sites.find((item) => item.reefId === reef.id && item.no.trim() === filing.siteNo.trim())
    : undefined
  if (!site) {
    return { total: 0, released: 0, held: 0, ledgerPending: 0, decisions: [] }
  }
  const allBelts = await db.belts.toArray()
  const beltIds = allBelts
    .filter(
      (belt) =>
        belt.siteId === site.id &&
        belt.surveyDate.trim() === filing.surveyDate.trim() &&
        // 已放行的不必重判；只处理挂起 / 未对账的
        belt.clearance?.status !== 'released'
    )
    .map((belt) => belt.id)
  return reconcileBelts(beltIds)
}

/**
 * outbox 重放：只重试巡护队一侧的台账写入。
 * 普查侧结论早已落库，这里不触碰普查库；成功一条移除一条。
 */
export async function flushLedgerOutbox(): Promise<{ retried: number; succeeded: number; stillPending: number }> {
  const tasks = await patrolDb.outbox.toArray()
  let succeeded = 0
  for (const task of tasks) {
    try {
      await putReconcileLedger(task.entry)
      await patrolDb.outbox.delete(task.id)
      succeeded += 1
    } catch (error) {
      await patrolDb.outbox.update(task.id, {
        attempts: task.attempts + 1,
        lastError: error instanceof Error ? error.message : '巡护台账写入失败',
        updatedAt: Date.now()
      } as never)
    }
  }
  const stillPending = await patrolDb.outbox.count()
  return { retried: tasks.length, succeeded, stillPending }
}

/* ------------------------- 旧数据升级：历史报备回填 ------------------------- */

/**
 * 旧数据没有报备记录：升级后按样带的调查日期向巡护队一侧回填一版报备单，全部标成待核。
 * 以「礁区 + 站位编号 + 调查日期」去重（同一天同站位的多条样带共用一张报备单）。
 * 幂等：已存在相同键的报备（任意状态）不再回填。
 */
export async function backfillLegacyFilings(): Promise<{ created: number; affectedBeltIds: string[] }> {
  await ensurePatrolReady()
  const [belts, sites, reefs, existingFilings] = await Promise.all([
    db.belts.toArray(),
    db.sites.toArray(),
    db.reefs.toArray(),
    patrolDb.filings.toArray()
  ])
  const existingKeys = new Set(existingFilings.map((filing) => filingKeyOf(filing)))
  const grouped = new Map<string, { reefName: string; siteNo: string; surveyDate: string; observer: string }>()
  const affectedBeltIds: string[] = []

  belts.forEach((belt) => {
    const site = sites.find((item) => item.id === belt.siteId)
    const reef = site ? reefs.find((item) => item.id === site.reefId) : undefined
    if (!site || !reef) return
    const key = `${reef.name.trim()}::${site.no.trim()}::${belt.surveyDate.trim()}`
    if (!grouped.has(key)) {
      grouped.set(key, {
        reefName: reef.name,
        siteNo: site.no,
        surveyDate: belt.surveyDate,
        observer: belt.observer
      })
    }
    affectedBeltIds.push(belt.id)
  })

  const now = Date.now()
  let seq = 0
  const toCreate: Filing[] = []
  grouped.forEach((value) => {
    const key = `${value.reefName.trim()}::${value.siteNo.trim()}::${value.surveyDate.trim()}`
    if (existingKeys.has(key)) return
    seq += 1
    toCreate.push({
      id: createId('filing'),
      no: `BA-LEGACY-${value.surveyDate.replace(/-/g, '')}-${String(seq).padStart(3, '0')}`,
      reefName: value.reefName,
      siteNo: value.siteNo,
      surveyDate: value.surveyDate,
      teamName: '历史普查数据（升级回填）',
      leader: value.observer || '',
      remark: '旧数据无报备记录，升级时按调查日期自动回填，待巡护队核对',
      status: 'verifying',
      source: 'legacy_backfill',
      reviewer: '',
      createdAt: now,
      updatedAt: now
    })
  })

  if (toCreate.length > 0) {
    await patrolDb.filings.bulkPut(toCreate)
  }
  return { created: toCreate.length, affectedBeltIds }
}
