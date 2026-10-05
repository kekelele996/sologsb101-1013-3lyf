/**
 * 对账逻辑（纯函数）：普查队录完样带后，按站位编号与作业日期跟巡护队数据对账。
 * - 站位没有报备单 / 报备单待核或被驳回 / 作业日期落在禁入期 → 挂起或待核
 * - 禁入期按日期区间判定（未撤销），撤销后重新判定即可放行
 */
import type { Belt } from '@/types/belt'
import type { BeltReportState, NoEntryPeriod, PatrolReport } from '@/types/patrol'

/** 单条样带的对账结论 */
export interface ReconcileVerdict {
  state: BeltReportState
  reason: string
  /** 关联的报备单 id（禁入期 / 未报备时为 null） */
  reportId: string | null
}

/** 日期字符串比较：a <= b（YYYY-MM-DD 可直接按字典序比较） */
function within(value: string, start: string, end: string): boolean {
  return value >= start && value <= end
}

/** 判断日期是否落在未撤销的禁入期内，返回命中的禁入期 */
export function findActiveNoEntry(date: string, periods: NoEntryPeriod[]): NoEntryPeriod | null {
  return periods.find((period) => !period.revoked && within(date, period.startDate, period.endDate)) ?? null
}

/**
 * 判定单条样带的报备状态。
 * @param stationNo 样带所在站位编号（对账按站位编号进行）
 * @param reports 巡护队报备单列表
 * @param periods 巡护队禁入期列表
 */
export function judgeBeltReport(
  belt: Belt,
  stationNo: string,
  reports: PatrolReport[],
  periods: NoEntryPeriod[]
): ReconcileVerdict {
  const noEntry = findActiveNoEntry(belt.surveyDate, periods)
  if (noEntry) {
    return {
      state: '已挂起',
      reason: `作业日期 ${belt.surveyDate} 落在禁入期「${noEntry.name}」（${noEntry.startDate} ~ ${noEntry.endDate}）内`,
      reportId: null
    }
  }

  const report = reports.find((item) => item.stationNo === stationNo && item.workDate === belt.surveyDate)
  if (!report) {
    return {
      state: '已挂起',
      reason: `站位 ${stationNo} 在 ${belt.surveyDate} 没有报备记录，请补报`,
      reportId: null
    }
  }
  if (report.status === '待核') {
    return {
      state: '待核',
      reason: `报备单 ${report.reportNo} 待巡护队核准`,
      reportId: report.id
    }
  }
  if (report.status === '已驳回') {
    return {
      state: '已挂起',
      reason: `报备单 ${report.reportNo} 已被驳回${report.remark ? `：${report.remark}` : ''}`,
      reportId: report.id
    }
  }
  return { state: '已批准', reason: '', reportId: report.id }
}

/** 批量对账：返回每条样带的结论（key 为样带 id） */
export function reconcileBelts(
  belts: Belt[],
  stationNoByBelt: Map<string, string>,
  reports: PatrolReport[],
  periods: NoEntryPeriod[]
): Map<string, ReconcileVerdict> {
  const result = new Map<string, ReconcileVerdict>()
  belts.forEach((belt) => {
    const stationNo = stationNoByBelt.get(belt.siteId) ?? ''
    result.set(belt.id, judgeBeltReport(belt, stationNo, reports, periods))
  })
  return result
}
