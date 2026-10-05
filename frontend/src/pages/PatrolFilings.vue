<script setup lang="ts">
/**
 * 巡护队页面 1：/patrol/filings 作业报备单与批准站位
 * - 登记普查队下水前报备（含挂起样带的补报，可从普查页带参预填）；
 * - 核对待核（历史回填）报备、批准 / 拒绝；批准后自动重判先前挂起样带；
 * - 批准站位列表（已批准报备按站位 + 日期去重）；
 * - 对账台账留底 + 写失败重试队列（只重试巡护队一侧）。
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useRoute } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, CircleCheck, Close, Plus, RefreshRight, WarningFilled } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { usePatrolStore } from '@/stores/patrolStore'
import { useReefStore } from '@/stores/reefStore'
import { useBeltStore } from '@/stores/beltStore'
import { FILING_STATUS_LABEL } from '@/types/filing'
import type { FilingStatus } from '@/types/filing'
import { HOLD_REASON_LABEL } from '@/types/clearance'
import {
  isLedgerFaultEnabled,
  PATROL_DB_NAME,
  PATROL_DB_VERSION,
  setLedgerFaultEnabled
} from '@/utils/patrolDb'
import { reconcileBelts, flushLedgerOutbox } from '@/utils/reconcile'

const route = useRoute()
const patrolStore = usePatrolStore()
const reefStore = useReefStore()
const beltStore = useBeltStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const reconciling = ref(false)
const faultEnabled = ref(isLedgerFaultEnabled())
const reviewer = ref('巡护员 何观潮')

const form = reactive({
  reefName: '',
  siteNo: '',
  surveyDate: new Date().toISOString().slice(0, 10),
  teamName: '',
  leader: '',
  remark: ''
})

/** 普查页「去补报」跳转参数 */
const prefillQuery = computed(() => ({
  reef: typeof route.query.reef === 'string' ? route.query.reef : '',
  site: typeof route.query.site === 'string' ? route.query.site : '',
  date: typeof route.query.date === 'string' ? route.query.date : ''
}))

function openCreate(prefill?: { reefName?: string; siteNo?: string; surveyDate?: string }): void {
  form.reefName = prefill?.reefName ?? form.reefName ?? ''
  form.siteNo = prefill?.siteNo ?? form.siteNo ?? ''
  form.surveyDate = prefill?.surveyDate ?? form.surveyDate ?? new Date().toISOString().slice(0, 10)
  form.teamName = ''
  form.leader = ''
  form.remark = ''
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.reefName.trim() || !form.siteNo.trim() || !form.surveyDate) {
    ElMessage.warning('请填写礁区名、站位编号与作业日期')
    return
  }
  submitting.value = true
  try {
    const { filing, duplicated } = await patrolStore.registerFiling({
      reefName: form.reefName.trim(),
      siteNo: form.siteNo.trim().toUpperCase(),
      surveyDate: form.surveyDate,
      teamName: form.teamName.trim() || '礁区普查队',
      leader: form.leader.trim(),
      remark: form.remark.trim()
    })
    if (duplicated) {
      ElMessage.info(`该站位当天已有批准报备 ${filing.no}，无需重复登记`)
    } else {
      ElMessage.success(`报备已登记为待核（${filing.no}），核对通过后挂起样带将自动重判放行`)
    }
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

function filingTagType(status: FilingStatus): 'success' | 'warning' | 'danger' | 'info' {
  if (status === 'approved') return 'success'
  if (status === 'verifying') return 'warning'
  return 'danger'
}

async function approve(filingId: string): Promise<void> {
  const result = await patrolStore.reviewFiling(filingId, 'approved', reviewer.value)
  if (!result.reviewed) {
    ElMessage.error('报备单不存在或已被处理')
    return
  }
  ElMessage.success(`已批准：先前挂起样带重判完成，放行 ${result.released} 条、仍挂起 ${result.held} 条`)
}

async function reject(filingId: string): Promise<void> {
  try {
    await ElMessageBox.confirm('拒绝后该站位当天无有效报备，相关样带将保持挂起。确认拒绝？', '拒绝报备', {
      type: 'warning',
      confirmButtonText: '拒绝',
      cancelButtonText: '取消'
    })
  } catch {
    return
  }
  await patrolStore.reviewFiling(filingId, 'rejected', reviewer.value)
  ElMessage.warning('报备已拒绝；该站位当天无有效批准件，相关样带维持挂起')
}

async function runFullReconcile(): Promise<void> {
  reconciling.value = true
  try {
    const result = await reconcileBelts()
    ElMessage.success(
      `全量对账完成：共 ${result.total} 条，放行 ${result.released} 条，挂起 ${result.held} 条` +
        (result.ledgerPending > 0 ? `；${result.ledgerPending} 条台账同步失败，已进重试队列` : '')
    )
  } finally {
    reconciling.value = false
  }
}

async function retryOutbox(): Promise<void> {
  // 重试前提示：若仍开着故障注入会继续失败
  const result = await flushLedgerOutbox()
  if (result.stillPending === 0) {
    ElMessage.success(`重试成功：${result.succeeded} 条巡护台账已补写（只重试了巡护队一侧）`)
  } else {
    ElMessage.warning(`重试 ${result.retried} 条，成功 ${result.succeeded} 条，仍有 ${result.stillPending} 条待重发`)
  }
}

function toggleFault(value: boolean): void {
  setLedgerFaultEnabled(value)
  faultEnabled.value = value
  ElMessage.info(value ? '已开启台账写入故障（演示单侧重试）' : '已关闭台账写入故障，可点「重试同步」')
}

function ledgerTagType(status: string): 'success' | 'danger' {
  return status === 'released' ? 'success' : 'danger'
}

onMounted(() => {
  reefStore.start()
  beltStore.start()
  patrolStore.start()
  if (prefillQuery.value.reef || prefillQuery.value.site) {
    openCreate({
      reefName: prefillQuery.value.reef,
      siteNo: prefillQuery.value.site,
      surveyDate: prefillQuery.value.date || undefined
    })
  }
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">巡护队 · 作业报备与批准站位</h2>
        <p class="gb-hint">
          普查队下水前在此报备站位编号与日期；批准通过即代表该站位当天在批准作业范围内。旧数据升级回填的报备统一为「待核」，核对后放行。
        </p>
      </div>
      <div class="page__actions">
        <el-button :icon="RefreshRight" :loading="reconciling" @click="runFullReconcile">全量对账重判</el-button>
        <el-button type="primary" :icon="Plus" @click="openCreate()">登记报备 / 补报</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="报备单" :value="patrolStore.filingStats.total" suffix="张" icon="Document" />
      <StatBadge label="已批准站位" :value="patrolStore.filingStats.approved" suffix="个" tone="success" icon="CircleCheck" />
      <StatBadge label="待核" :value="patrolStore.filingStats.verifying" suffix="张" tone="warning" icon="QuestionFilled" />
      <StatBadge label="生效禁入期" :value="patrolStore.activeClosureCount" suffix="条" tone="info" icon="Lock" />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>批准站位（批准通过的报备）</h3>
        <span class="gb-hint">按礁区 + 站位编号 + 日期去重；普查队对账时落在其中才放行</span>
      </div>
      <EmptyPanel
        v-if="patrolStore.approvedSites.length === 0"
        title="还没有批准站位"
        description="登记报备并核对通过后，该站位当天即进入批准作业范围。"
        compact
      />
      <el-table v-else :data="patrolStore.approvedSites" border stripe class="gb-table-compact">
        <el-table-column prop="no" label="报备单号" min-width="170" />
        <el-table-column prop="reefName" label="礁区" min-width="160" />
        <el-table-column prop="siteNo" label="站位编号" width="110" align="center" />
        <el-table-column prop="surveyDate" label="作业日期" width="130" />
        <el-table-column prop="teamName" label="作业组" min-width="150" />
        <el-table-column prop="reviewer" label="核对人" width="130" />
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>作业报备单（{{ patrolStore.filings.length }} 张）</h3>
        <span class="gb-hint">待核含升级回填的历史报备；批准 / 拒绝会立即触发普查侧挂起样带重判</span>
      </div>
      <EmptyPanel
        v-if="patrolStore.filings.length === 0"
        title="暂无报备单"
        description="普查队下水前应先报备站位编号与日期；挂起样带也可在此补报。"
        action-text="登记报备 / 补报"
        @action="openCreate()"
      />
      <el-table v-else :data="patrolStore.filings" border stripe class="gb-table-compact">
        <el-table-column prop="no" label="报备单号" min-width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.no }}</span>
            <el-tag v-if="row.source === 'legacy_backfill'" size="small" type="warning" effect="plain" style="margin-left: 6px">
              升级回填
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="礁区 / 站位" min-width="190">
          <template #default="{ row }">
            <div>{{ row.reefName }}</div>
            <div class="gb-hint">站位 {{ row.siteNo }} · {{ row.surveyDate }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="teamName" label="作业组 / 领队" min-width="150">
          <template #default="{ row }">
            <div>{{ row.teamName }}</div>
            <div class="gb-hint">{{ row.leader || '未填领队' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="filingTagType(row.status)" size="small" effect="light">
              {{ FILING_STATUS_LABEL[row.status as FilingStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="200" show-overflow-tooltip />
        <el-table-column label="核对" width="200" fixed="right">
          <template #default="{ row }">
          <template v-if="row.status !== 'approved'">
              <el-button size="small" type="success" :icon="Check" @click="approve(row.id)">核对通过</el-button>
              <el-button size="small" type="danger" plain :icon="Close" @click="reject(row.id)">拒绝</el-button>
            </template>
            <span v-else class="gb-hint">{{ row.reviewer || '已批准' }}</span>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>对账台账留底与单侧重试</h3>
        <div class="page__tools">
          <span class="gb-hint">台账写失败只重试巡护队一侧，普查侧结论不回滚</span>
          <el-tag :type="faultEnabled ? 'danger' : 'info'" size="small" effect="plain">
            台账写入故障：{{ faultEnabled ? '开' : '关' }}
          </el-tag>
          <el-switch :model-value="faultEnabled" size="small" @change="toggleFault" />
          <el-button size="small" type="warning" plain :icon="RefreshRight" :disabled="patrolStore.outbox.length === 0" @click="retryOutbox">
            重试同步（{{ patrolStore.outbox.length }}）
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="patrolStore.outbox.length > 0"
        type="error"
        show-icon
        :closable="false"
        :title="`有 ${patrolStore.outbox.length} 条对账台账写入巡护队一侧失败（挂起 / 放行结论已在普查侧生效），关闭故障后点「重试同步」即可补写。`"
      />

      <EmptyPanel
        v-if="patrolStore.ledger.length === 0"
        title="暂无对账台账"
        description="普查队录完样带并执行对账后，每条样带的放行结论会同步留底到这里。"
        compact
      />
      <el-table v-else :data="patrolStore.ledger" border stripe class="gb-table-compact">
        <el-table-column label="样带" min-width="200">
          <template #default="{ row }">
            <div>{{ row.reefName }} · 站位 {{ row.siteNo }} · {{ row.beltNo }}</div>
            <div class="gb-hint">{{ row.surveyDate }}</div>
          </template>
        </el-table-column>
        <el-table-column label="结论" width="110" align="center">
          <template #default="{ row }">
            <el-tag :type="ledgerTagType(row.status)" size="small" effect="light">
              {{ row.status === 'released' ? '放行' : '挂起' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="挂起原因 / 命中单据" min-width="220">
          <template #default="{ row }">
            <span v-if="row.status === 'released'">{{ row.filingNo || '—' }}</span>
            <span v-else>
              <el-icon color="#c0392b"><WarningFilled /></el-icon>
              {{ row.holdReason ? HOLD_REASON_LABEL[row.holdReason as keyof typeof HOLD_REASON_LABEL] : '—' }}
              <span class="gb-hint">{{ row.closureNo || row.filingNo || '' }}</span>
            </span>
          </template>
        </el-table-column>
        <el-table-column prop="note" label="说明" min-width="260" show-overflow-tooltip />
        <el-table-column label="对账时间" width="170">
          <template #default="{ row }">
            <span class="gb-mono">{{ new Date(row.reconciledAt).toLocaleString('zh-CN') }}</span>
          </template>
        </el-table-column>
      </el-table>

      <el-table
        v-if="patrolStore.outbox.length > 0"
        :data="patrolStore.outbox"
        border
        stripe
        size="small"
        style="margin-top: 12px"
      >
        <template #empty><span /></template>
        <el-table-column label="待重发样带" min-width="200">
          <template #default="{ row }">{{ row.entry.reefName }} · 站位 {{ row.entry.siteNo }} · {{ row.entry.beltNo }}</template>
        </el-table-column>
        <el-table-column prop="attempts" label="已尝试" width="90" align="right" />
        <el-table-column prop="lastError" label="上次错误" min-width="220" show-overflow-tooltip />
      </el-table>

      <p class="gb-hint" style="margin-top: 10px">
        <el-icon><CircleCheck /></el-icon>
        巡护库 {{ PATROL_DB_NAME }} v{{ PATROL_DB_VERSION }} 与普查库分开持有：本页数据只留在巡护队一侧。
      </p>
    </el-card>

    <el-dialog v-model="dialogVisible" title="登记作业报备 / 补报" width="540px" :close-on-click-modal="false">
      <el-form label-width="96px">
        <el-form-item label="礁区名" required>
          <el-select v-model="form.reefName" filterable allow-create placeholder="选择或输入礁区名" style="width: 100%">
            <el-option v-for="reef in reefStore.reefs" :key="reef.id" :label="reef.name" :value="reef.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="站位编号" required>
          <el-input v-model="form.siteNo" placeholder="如：S-01" maxlength="24" />
        </el-form-item>
        <el-form-item label="作业日期" required>
          <el-date-picker v-model="form.surveyDate" type="date" value-format="YYYY-MM-DD" placeholder="选择作业日期" />
        </el-form-item>
        <el-form-item label="作业组">
          <el-input v-model="form.teamName" placeholder="如：礁区普查一组" maxlength="40" />
        </el-form-item>
        <el-form-item label="领队">
          <el-input v-model="form.leader" placeholder="如：林之遥" maxlength="20" />
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="form.remark" type="textarea" :rows="2" placeholder="作业内容、船名、人数等" maxlength="120" />
        </el-form-item>
        <el-form-item label="核对人">
          <el-input v-model="reviewer" placeholder="批准 / 核对操作人" maxlength="20" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">登记（待核）</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.page__head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.page__title {
  margin: 0 0 4px;
  font-size: 19px;
  color: #0b5d5a;
}

.page__actions,
.page__tools {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
</style>
