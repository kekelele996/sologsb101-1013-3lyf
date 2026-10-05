/**
 * 放行对账（普查队一侧持有的对账结果）
 * 普查队录完一批样带后按站位编号 + 调查日期跟巡护队对账：
 * 在批准范围内且不在禁入期 → released 放行；否则 held 挂起等补报 / 等解禁。
 * 挂起样带的覆盖与白化照常记录，但不进对外白化汇总，保证报出去的礁区情况与巡护记录对得上。
 */

/** 样带放行状态：undefined（未对账）/ held 挂起 / released 放行 */
export type ClearanceStatus = 'held' | 'released'

/** 挂起原因 */
export type HoldReason = 'unfiled' | 'verifying' | 'rejected' | 'closed'

export const HOLD_REASON_LABEL: Record<HoldReason, string> = {
  unfiled: '无报备记录',
  verifying: '报备待核（历史回填）',
  rejected: '报备被拒绝',
  closed: '落在禁入期'
}

/** 普查侧样带携带的对账结果（写入 belt 行；字段仅普查队一侧使用） */
export interface ClearanceState {
  status: ClearanceStatus
  /** 最近一次挂起原因（放行时清空） */
  holdReason: HoldReason | null
  /** 命中的禁入通告号（挂起原因为禁入期时） */
  closureNo: string | null
  /** 命中的报备单号（放行或待核 / 拒绝时） */
  filingNo: string | null
  /** 最近一次对账时间（ms） */
  reconciledAt: number | null
  /** 最近一次对账结论说明 */
  reconcileNote: string
}

export function createPendingClearance(): ClearanceState {
  return {
    status: 'held',
    holdReason: null,
    closureNo: null,
    filingNo: null,
    reconciledAt: null,
    reconcileNote: ''
  }
}

export const CLEARANCE_STATUS_LABEL: Record<ClearanceStatus, string> = {
  held: '挂起',
  released: '放行'
}

/** 巡护队一侧保存的对账台账行：每批对账后同步给巡护队留底 */
export interface ReconcileLedgerEntry {
  /** 主键：样带 id（一条样带只保留最近一次对账结果） */
  beltId: string
  beltNo: string
  reefName: string
  siteNo: string
  surveyDate: string
  status: ClearanceStatus
  holdReason: HoldReason | null
  closureNo: string | null
  filingNo: string | null
  note: string
  reconciledAt: number
}

/** 单条样带的对账判定结果（纯计算，不写库） */
export interface ClearanceDecision {
  status: ClearanceStatus
  holdReason: HoldReason | null
  closureNo: string | null
  filingNo: string | null
  note: string
}

/** 巡护台账写入失败时的重试任务：只重试巡护队一侧写入 */
export interface ReconcileOutboxTask {
  id: string
  /** 目标表：目前只有 reconcileLedger */
  target: 'reconcileLedger'
  entry: ReconcileLedgerEntry
  attempts: number
  lastError: string
  createdAt: number
  updatedAt: number
}

/** 一批样带对账的统计结果 */
export interface ReconcileBatchResult {
  total: number
  released: number
  held: number
  /** 巡护台账同步失败条数（普查侧判定已生效，仅待重发） */
  ledgerPending: number
  decisions: Array<{ beltId: string; decision: ClearanceDecision }>
}
