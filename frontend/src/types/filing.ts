/**
 * 作业报备单（巡护队一侧持有）
 * 普查队下水前向保护区巡护队报备「在哪个礁区、哪个站位编号、哪一天作业」。
 * 报备记录只留在巡护队侧；批准通过的报备单即代表该站位当天在批准作业范围内。
 */

/** 报备单状态：待核用于旧数据回填，批准/拒绝由巡护队核对后给出 */
export type FilingStatus = 'verifying' | 'approved' | 'rejected'

export const FILING_STATUSES: FilingStatus[] = ['verifying', 'approved', 'rejected']

export const FILING_STATUS_LABEL: Record<FilingStatus, string> = {
  verifying: '待核',
  approved: '已批准',
  rejected: '已拒绝'
}

/** 报备来源：normal 为本轮新报备，legacy_backfill 为升级时按调查日期回填的历史报备 */
export type FilingSource = 'normal' | 'legacy_backfill'

export interface Filing {
  id: string
  /** 报备单号，如 BA-20261005-S01-001 */
  no: string
  /** 礁区名（对账时与普查侧礁区名对齐） */
  reefName: string
  /** 站位编号（对账键，如 S-01） */
  siteNo: string
  /** 作业日期 YYYY-MM-DD（对账键） */
  surveyDate: string
  /** 普查队 / 作业组名称 */
  teamName: string
  /** 领队或联系人 */
  leader: string
  /** 报备备注（作业内容、船名等） */
  remark: string
  status: FilingStatus
  source: FilingSource
  /** 巡护队审核人（批准 / 拒绝 / 核对时填写） */
  reviewer: string
  createdAt: number
  updatedAt: number
}

/** 新建报备单入参 */
export type NewFiling = Omit<Filing, 'id' | 'createdAt' | 'updatedAt'>

/** 对账键：礁区名 + 站位编号 + 调查日期（站位编号在不同礁区间会重复，必须带礁区名） */
export interface ReconcileKey {
  reefName: string
  siteNo: string
  surveyDate: string
}

export function filingKeyOf(filing: Pick<Filing, 'reefName' | 'siteNo' | 'surveyDate'>): string {
  return reconcileKey(filing.reefName, filing.siteNo, filing.surveyDate)
}

export function reconcileKey(reefName: string, siteNo: string, surveyDate: string): string {
  return `${reefName.trim()}::${siteNo.trim()}::${surveyDate.trim()}`
}

/** 生成报备单号：BA-日期-站位编号-随机尾号 */
export function nextFilingNo(surveyDate: string, siteNo: string): string {
  const compactDate = surveyDate.replace(/-/g, '')
  const compactSite = siteNo.replace(/[^A-Za-z0-9]/g, '').toUpperCase() || 'SITE'
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `BA-${compactDate}-${compactSite}-${rand}`
}
