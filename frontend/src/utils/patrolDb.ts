/**
 * 巡护队一侧的本地持久化层（Dexie 封装），与普查库 gbcoralbelt 完全分开：
 * 巡护队管作业报备单、批准站位（批准通过的报备单）、禁入期，以及普查队同步过来的对账台账。
 * - 库名 gbcoralpatrol，结构版本 PATROL_DB_VERSION
 * - 纯前端应用：两个 IndexedDB 各自持有自己一侧的数据，互不同步表结构，
 *   对账时只读对方的必要字段（礁区名 / 站位编号 / 调查日期）。
 */
import Dexie, { liveQuery, type Table } from 'dexie'
import { createId } from '@/utils/id'
import type { Closure } from '@/types/closure'
import type { Filing } from '@/types/filing'
import type { ReconcileLedgerEntry, ReconcileOutboxTask } from '@/types/clearance'

/** 巡护库当前结构版本号 */
export const PATROL_DB_VERSION = 1

/** 巡护库名（浏览器 IndexedDB 中的库名） */
export const PATROL_DB_NAME = 'gbcoralpatrol'

/** localStorage 侧少量元数据键名 */
export const PATROL_LS_KEYS = {
  dbVersion: 'gbcoralpatrol:db-version',
  /** 演示 / 回填初始化幂等标记 */
  seeded: 'gbcoralpatrol:seeded-v1',
  /** 台账写入故障注入开关（演示「只重试巡护队一侧」用） */
  ledgerFault: 'gbcoralpatrol:ledger-fault'
} as const

export class PatrolDatabase extends Dexie {
  /** 作业报备单（批准通过即代表该站位当天在批准作业范围内） */
  filings!: Table<Filing, string>
  /** 禁入期 */
  closures!: Table<Closure, string>
  /** 普查队每批对账后同步过来的台账（主键为样带 id，保留最近一次结论） */
  reconcileLedger!: Table<ReconcileLedgerEntry, string>
  /** 台账写入失败时的重试任务（只重试巡护队一侧） */
  outbox!: Table<ReconcileOutboxTask, string>

  constructor() {
    super(PATROL_DB_NAME)

    this.version(PATROL_DB_VERSION).stores({
      // 复合索引 reefName+siteNo+surveyDate 供对账按站位编号 + 日期精确匹配
      filings: 'id, no, reefName, siteNo, surveyDate, status, source, [reefName+siteNo+surveyDate]',
      closures: 'id, no, reefName, siteNo, status, startDate, endDate',
      reconcileLedger: 'beltId, reefName, siteNo, surveyDate, status, reconciledAt',
      outbox: 'id, target, updatedAt'
    })
  }
}

export const patrolDb = new PatrolDatabase()

/**
 * 巡护台账写入故障注入：打开后 put 台账一律失败，用于演示单侧重试；重试前关掉即可。
 * localStorage 不可用（隐私模式 / node 测试）时退化为模块内内存标记。
 */
let ledgerFaultMemory = false

export function setLedgerFaultEnabled(enabled: boolean): void {
  ledgerFaultMemory = enabled
  try {
    if (enabled) localStorage.setItem(PATROL_LS_KEYS.ledgerFault, '1')
    else localStorage.removeItem(PATROL_LS_KEYS.ledgerFault)
  } catch {
    // 隐私模式下使用内存标记
  }
}

export function isLedgerFaultEnabled(): boolean {
  try {
    return localStorage.getItem(PATROL_LS_KEYS.ledgerFault) === '1' || ledgerFaultMemory
  } catch {
    return ledgerFaultMemory
  }
}

/**
 * 向巡护队一侧写对账台账（put 语义：同一样带只保留最近一次结论）。
 * 普查侧判定已经落定，这里失败不能回滚普查数据，只入 outbox 等重试。
 */
export async function putReconcileLedger(entry: ReconcileLedgerEntry): Promise<void> {
  if (isLedgerFaultEnabled()) {
    throw new Error('巡护台账写入失败（故障注入）')
  }
  await patrolDb.reconcileLedger.put(entry)
}

/** 打开巡护库（不播种；播种 / 历史回填由 patrol 域服务按幂等标记执行） */
export async function initPatrolDatabase(): Promise<void> {
  await patrolDb.open()
  stampPatrolDbVersion()
}

/** 订阅单表变化（liveQuery），返回取消订阅函数 */
export function watchPatrolTable<T>(table: () => Table<T, string>): {
  subscribe: (cb: (rows: T[]) => void) => () => void
} {
  return {
    subscribe(cb: (rows: T[]) => void): () => void {
      const observable = liveQuery(async () => table().toArray())
      const subscription = observable.subscribe({
        next: (rows: T[]) => cb(rows),
        error: () => cb([])
      })
      return () => subscription.unsubscribe()
    }
  }
}

/** 生成主键（巡护库统一走共享工具） */
export { createId }

/** 写入结构版本号到 localStorage */
export function stampPatrolDbVersion(): void {
  try {
    localStorage.setItem(PATROL_LS_KEYS.dbVersion, String(PATROL_DB_VERSION))
  } catch {
    // 忽略
  }
}

export function readStampedPatrolDbVersion(): number {
  try {
    const raw = localStorage.getItem(PATROL_LS_KEYS.dbVersion)
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : PATROL_DB_VERSION
  } catch {
    return PATROL_DB_VERSION
  }
}
