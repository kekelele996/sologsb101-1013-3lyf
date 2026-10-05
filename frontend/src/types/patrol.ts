/**
 * 巡护队侧模型：作业报备单、禁入期与样带报备对账状态。
 * 普查队（样带 / 底质 / 珊瑚覆盖长度）与巡护队（报备单 / 批准站位 / 禁入期）各持一份，
 * 录完样带后按站位编号对账：未批准或落在禁入期的样带挂起，补报通过后放行。
 */

/** 报备单状态：待核 / 已批准 / 已驳回 */
export type ReportStatus = '待核' | '已批准' | '已驳回'

export const REPORT_STATUSES: ReportStatus[] = ['待核', '已批准', '已驳回']

/** 样带报备对账状态（普查队样带经巡护队数据判定后的结论） */
export type BeltReportState = '未报备' | '待核' | '已批准' | '已挂起'

export const BELT_REPORT_STATES: BeltReportState[] = ['未报备', '待核', '已批准', '已挂起']

/** 报备单状态配色（Element Plus tag type） */
export const REPORT_STATUS_TYPE: Record<ReportStatus, '' | 'success' | 'warning' | 'danger' | 'info'> = {
  待核: 'warning',
  已批准: 'success',
  已驳回: 'danger'
}

/** 样带报备状态配色 */
export const BELT_REPORT_STATE_TYPE: Record<BeltReportState, '' | 'success' | 'warning' | 'danger' | 'info'> = {
  未报备: 'info',
  待核: 'warning',
  已批准: 'success',
  已挂起: 'danger'
}

/**
 * 作业报备单：巡护队持有的作业报备记录。
 * 按「站位编号 + 作业日期」对账，批准后该站位该日期方可下水。
 */
export interface PatrolReport {
  id: string
  /** 报备单编号，如 BB-001 */
  reportNo: string
  /** 站位编号（普查队样带所在站位的编号，如 S-01） */
  stationNo: string
  /** 作业日期（YYYY-MM-DD） */
  workDate: string
  /** 报备状态 */
  status: ReportStatus
  /** 备注（自动报备 / 补报备 / 驳回原因等） */
  remark: string
  createdAt: number
  updatedAt: number
}

/** 禁入期：巡护队划定的禁止进入时段（按日期区间，覆盖全部站位） */
export interface NoEntryPeriod {
  id: string
  /** 禁入期名称 / 事由，如 台风应急响应 */
  name: string
  /** 开始日期（YYYY-MM-DD） */
  startDate: string
  /** 结束日期（YYYY-MM-DD） */
  endDate: string
  /** 事由说明 */
  reason: string
  /** 是否已撤销（撤销后既往挂起样带重新判定） */
  revoked: boolean
  createdAt: number
  updatedAt: number
}

/** 新建报备单入参 */
export type NewPatrolReport = Omit<PatrolReport, 'id' | 'createdAt' | 'updatedAt'>

/** 新建禁入期入参 */
export type NewNoEntryPeriod = Omit<NoEntryPeriod, 'id' | 'createdAt' | 'updatedAt'>

export function createEmptyPatrolReport(): NewPatrolReport {
  return { reportNo: '', stationNo: '', workDate: '', status: '待核', remark: '' }
}

export function createEmptyNoEntryPeriod(): NewNoEntryPeriod {
  const today = new Date().toISOString().slice(0, 10)
  return { name: '', startDate: today, endDate: today, reason: '', revoked: false }
}
