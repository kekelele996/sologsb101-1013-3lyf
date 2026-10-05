/**
 * 巡护队一侧演示数据与初始化编排。
 * 全新打开应用时：普查库播种演示样带 → 巡护库播种报备 / 禁入 → 全量对账一次，
 * 让普查页与巡护页开箱即能看到放行、挂起（无报备 / 待核）、禁入期撤销后放行等状态。
 */
import { db } from '@/utils/db'
import { createId, patrolDb, PATROL_LS_KEYS } from '@/utils/patrolDb'
import type { Closure } from '@/types/closure'
import type { Filing } from '@/types/filing'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

/** 清空巡护库全部表（普查页「清空并重建演示数据」时两侧一起重置） */
export async function clearPatrolTables(): Promise<void> {
  await patrolDb.transaction('rw', [patrolDb.filings, patrolDb.closures, patrolDb.reconcileLedger, patrolDb.outbox], async () => {
    await Promise.all([
      patrolDb.filings.clear(),
      patrolDb.closures.clear(),
      patrolDb.reconcileLedger.clear(),
      patrolDb.outbox.clear()
    ])
  })
}

/**
 * 播种巡护演示数据：
 * - 清澜湾 S-01 今天：报备已批准 → 放行；同时有一条已撤销的今天禁入通告（撤销后应放行）；
 * - 清澜湾 S-02 今天：无报备 → 挂起等补报；另有一条明天起的未来禁入通告（不影响今天）；
 * - 永兴岛 S-01 今天：报备待核（历史回填来源）→ 挂起等核对；
 * - 大洲岛 S-01 今天：报备已批准 → 放行。
 */
export async function seedPatrolDemoData(): Promise<void> {
  const today = todayIso()
  const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10)
  const now = Date.now()

  const filings: Filing[] = [
    {
      id: 'filing_demo_ql01',
      no: 'BA-DEMO-QL01',
      reefName: '清澜湾珊瑚礁区',
      siteNo: 'S-01',
      surveyDate: today,
      teamName: '礁区普查一组',
      leader: '林之遥',
      remark: '底质与珊瑚覆盖普查（演示：已批准）',
      status: 'approved',
      source: 'normal',
      reviewer: '巡护员 何观潮',
      createdAt: now - 1000,
      updatedAt: now - 1000
    },
    {
      id: 'filing_demo_yr01',
      no: 'BA-DEMO-YR01',
      reefName: '永兴岛西侧礁盘',
      siteNo: 'S-01',
      surveyDate: today,
      teamName: '历史普查数据（升级回填）',
      leader: '陈立群',
      remark: '旧数据无报备记录，升级时按调查日期自动回填，待巡护队核对',
      status: 'verifying',
      source: 'legacy_backfill',
      reviewer: '',
      createdAt: now - 900,
      updatedAt: now - 900
    },
    {
      id: 'filing_demo_dz01',
      no: 'BA-DEMO-DZ01',
      reefName: '大洲岛南岸礁区',
      siteNo: 'S-01',
      surveyDate: today,
      teamName: '礁区普查二组',
      leader: '陈立群',
      remark: '台风后礁区复查（演示：已批准）',
      status: 'approved',
      source: 'normal',
      reviewer: '巡护员 何观潮',
      createdAt: now - 800,
      updatedAt: now - 800
    }
  ]

  const closures: Closure[] = [
    {
      id: 'closure_demo_revoked',
      no: 'NO-DEMO-REVOKED',
      reefName: '清澜湾珊瑚礁区',
      siteNo: 'S-01',
      startDate: today,
      endDate: today,
      reason: '临时管控（演示：当天已撤销，撤销后挂起样带应重新判定放行）',
      issuer: '巡护员 何观潮',
      status: 'revoked',
      revokedBy: '巡护员 何观潮',
      revokedAt: now - 700,
      revokeNote: '管控提前结束，恢复作业',
      createdAt: now - 720,
      updatedAt: now - 700
    },
    {
      id: 'closure_demo_future',
      no: 'NO-DEMO-FUTURE',
      reefName: '清澜湾珊瑚礁区',
      siteNo: 'S-02',
      startDate: tomorrow,
      endDate: tomorrow,
      reason: '生态敏感期临时禁入（演示：明天生效，今天不影响）',
      issuer: '巡护员 何观潮',
      status: 'active',
      revokedBy: '',
      revokedAt: null,
      revokeNote: '',
      createdAt: now - 600,
      updatedAt: now - 600
    }
  ]

  await patrolDb.filings.bulkPut(filings)
  await patrolDb.closures.bulkPut(closures)
}

/** 巡护侧是否已完成首次初始化（幂等标记） */
export function isPatrolSeeded(): boolean {
  try {
    return localStorage.getItem(PATROL_LS_KEYS.seeded) === '1'
  } catch {
    return false
  }
}

export function markPatrolSeeded(): void {
  try {
    localStorage.setItem(PATROL_LS_KEYS.seeded, '1')
  } catch {
    // 忽略
  }
}

export function clearPatrolSeededMark(): void {
  try {
    localStorage.removeItem(PATROL_LS_KEYS.seeded)
  } catch {
    // 忽略
  }
}

/** 重置巡护库为演示数据（不清空普查库） */
export async function resetPatrolDemoData(): Promise<void> {
  await clearPatrolTables()
  await seedPatrolDemoData()
  markPatrolSeeded()
}

/** 普查库是否已有样带（首次初始化判断用） */
export async function surveyHasBelts(): Promise<boolean> {
  return (await db.belts.count()) > 0
}

/** 供外部模块复用的主键工具 */
export { createId }
