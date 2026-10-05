/** 样带朝向 */
export type Orientation = '北' | '东' | '南' | '西'

export const ORIENTATIONS: Orientation[] = ['北', '东', '南', '西']

/** 样带报备对账状态（由巡护队报备数据判定，存于普查队样带侧） */
export type BeltReportState = '未报备' | '待核' | '已批准' | '已挂起'

/** 样带：站位上布设的普查样带 */
export interface Belt {
  id: string
  /** 所属站位 */
  siteId: string
  /** 样带编号，如 T-01 */
  no: string
  /** 样带长度（m） */
  lengthM: number
  /** 朝向 */
  orientation: Orientation
  /** 调查日期 */
  surveyDate: string
  /** 调查人 */
  observer: string
  /** 报备对账状态：未报备 / 待核 / 已批准 / 已挂起 */
  reportState: BeltReportState
  /** 挂起 / 待核原因（禁入期、未报备、待核准等） */
  suspendReason: string
  /** 关联的巡护队报备单 id（对账后回填） */
  reportId: string | null
  /** 巡护队侧写入是否已确认；false 表示普查队样带已写入、巡护队侧失败，只重试巡护队一侧 */
  syncedToPatrol: boolean
  createdAt: number
  updatedAt: number
}

/** 样带布设草稿（存于 beltStore） */
export interface BeltDraft {
  no: string
  lengthM: number
  orientation: Orientation
  surveyDate: string
  observer: string
}

export function createEmptyBeltDraft(no = ''): BeltDraft {
  return {
    no,
    lengthM: 50,
    orientation: '北',
    surveyDate: new Date().toISOString().slice(0, 10),
    observer: ''
  }
}

/** 常用样带长度预设（m） */
export const BELT_LENGTH_PRESETS: number[] = [10, 20, 25, 50, 100]
