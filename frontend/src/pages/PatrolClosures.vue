<script setup lang="ts">
/**
 * 巡护队页面 2：/patrol/closures 禁入期管理
 * 发布 / 撤销禁入期；撤销后先前因此挂起的样带自动重新判定（可能放行）。
 */
import { onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Lock, Plus, Unlock } from '@element-plus/icons-vue'
import StatBadge from '@/components/common/StatBadge.vue'
import EmptyPanel from '@/components/common/EmptyPanel.vue'
import { usePatrolStore } from '@/stores/patrolStore'
import { useReefStore } from '@/stores/reefStore'
import { CLOSURE_STATUS_LABEL } from '@/types/closure'
import type { ClosureStatus } from '@/types/closure'

const patrolStore = usePatrolStore()
const reefStore = useReefStore()

const dialogVisible = ref(false)
const submitting = ref(false)
const form = reactive({
  reefName: '',
  siteNo: '',
  range: [] as string[],
  reason: '',
  issuer: '巡护员 何观潮'
})
const operator = ref('巡护员 何观潮')

function openCreate(): void {
  const today = new Date().toISOString().slice(0, 10)
  form.reefName = reefStore.reefs[0]?.name ?? ''
  form.siteNo = ''
  form.range = [today, today]
  form.reason = ''
  dialogVisible.value = true
}

async function submitForm(): Promise<void> {
  if (!form.reefName.trim() || form.range.length !== 2 || !form.range[0] || !form.range[1]) {
    ElMessage.warning('请填写礁区名并选择禁入起止日期')
    return
  }
  submitting.value = true
  try {
    await patrolStore.createClosure({
      reefName: form.reefName.trim(),
      siteNo: form.siteNo.trim().toUpperCase(),
      startDate: form.range[0],
      endDate: form.range[1],
      reason: form.reason.trim() || '临时管控',
      issuer: form.issuer.trim() || '巡护队'
    })
    ElMessage.success('禁入期已发布；落在该区间且尚未对账的样带将在下次对账时挂起')
    dialogVisible.value = false
  } finally {
    submitting.value = false
  }
}

async function revoke(id: string): Promise<void> {
  let note = ''
  try {
    const { value } = await ElMessageBox.prompt('撤销后先前因该禁入期挂起的样带将自动重新判定，请填写撤销说明：', '撤销禁入期', {
      confirmButtonText: '撤销并重判',
      cancelButtonText: '取消',
      inputValue: '管控结束，恢复作业',
      inputValidator: (value: string) => value.trim().length > 0 || '请填写撤销说明'
    })
    note = value
  } catch {
    return
  }
  const result = await patrolStore.revokeClosure(id, operator.value, note)
  if (!result.revoked) {
    ElMessage.error('禁入期不存在或已撤销')
    return
  }
  ElMessage.success(`禁入期已撤销，相关样带重判完成：放行 ${result.released} 条、仍挂起 ${result.held} 条`)
}

function closureTagType(status: ClosureStatus): 'danger' | 'info' {
  return status === 'active' ? 'danger' : 'info'
}

onMounted(() => {
  reefStore.start()
  patrolStore.start()
})
</script>

<template>
  <section class="page">
    <div class="gb-brand-bar" />

    <div class="page__head">
      <div>
        <h2 class="page__title">巡护队 · 禁入期管理</h2>
        <p class="gb-hint">
          禁入期内的样带即使已报备也挂起；撤销禁入期后系统自动重新判定先前挂起的样带，符合条件的立即放行。
        </p>
      </div>
      <div class="page__actions">
        <el-button type="primary" :icon="Plus" @click="openCreate">发布禁入期</el-button>
      </div>
    </div>

    <div class="gb-stats-row">
      <StatBadge label="禁入通告" :value="patrolStore.closures.length" suffix="条" icon="Lock" />
      <StatBadge label="生效中" :value="patrolStore.activeClosureCount" suffix="条" tone="warning" icon="WarningFilled" />
      <StatBadge
        label="已撤销"
        :value="patrolStore.closures.filter((item) => item.status === 'revoked').length"
        suffix="条"
        tone="success"
        icon="Unlock"
      />
    </div>

    <el-card shadow="never" class="gb-panel">
      <div class="gb-panel-title">
        <h3>禁入通告（{{ patrolStore.closures.length }} 条）</h3>
        <span class="gb-hint">撤销只改状态留档，不删除通告记录</span>
      </div>
      <EmptyPanel
        v-if="patrolStore.closures.length === 0"
        title="暂无禁入期"
        description="生态敏感期或执法管控时可在此发布禁入通告，普查队对账时落在区间内的样带自动挂起。"
        action-text="发布禁入期"
        @action="openCreate"
      />
      <el-table v-else :data="patrolStore.closures" border stripe class="gb-table-compact">
        <el-table-column prop="no" label="通告号" min-width="170" />
        <el-table-column label="礁区 / 站位" min-width="200">
          <template #default="{ row }">
            <div>{{ row.reefName }}</div>
            <div class="gb-hint">{{ row.siteNo ? `站位 ${row.siteNo}` : '全礁区' }}</div>
          </template>
        </el-table-column>
        <el-table-column label="禁入区间" min-width="210">
          <template #default="{ row }">
            <span class="gb-mono">{{ row.startDate }} ~ {{ row.endDate }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="reason" label="事由" min-width="220" show-overflow-tooltip />
        <el-table-column prop="issuer" label="发布人" width="130" />
        <el-table-column label="状态" width="100" align="center">
          <template #default="{ row }">
            <el-tag :type="closureTagType(row.status)" size="small" effect="light">
              {{ CLOSURE_STATUS_LABEL[row.status as ClosureStatus] }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="撤销留档" min-width="200">
          <template #default="{ row }">
            <template v-if="row.status === 'revoked'">
              <div>{{ row.revokeNote }}</div>
              <div class="gb-hint">
                {{ row.revokedBy }} · {{ row.revokedAt ? new Date(row.revokedAt).toLocaleString('zh-CN') : '' }}
              </div>
            </template>
            <span v-else class="gb-hint">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="130" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'active'"
              size="small"
              type="warning"
              plain
              :icon="Unlock"
              @click="revoke(row.id)"
            >
              撤销并重判
            </el-button>
            <el-icon v-else color="#1e8449"><Lock /></el-icon>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <el-dialog v-model="dialogVisible" title="发布禁入期" width="540px" :close-on-click-modal="false">
      <el-form label-width="96px">
        <el-form-item label="礁区名" required>
          <el-select v-model="form.reefName" filterable allow-create placeholder="选择或输入礁区名" style="width: 100%">
            <el-option v-for="reef in reefStore.reefs" :key="reef.id" :label="reef.name" :value="reef.name" />
          </el-select>
        </el-form-item>
        <el-form-item label="站位编号">
          <el-input v-model="form.siteNo" placeholder="留空表示覆盖整个礁区；多个用逗号分隔，如 S-01,S-02" maxlength="60" />
        </el-form-item>
        <el-form-item label="禁入区间" required>
          <el-date-picker
            v-model="form.range"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="开始日期"
            end-placeholder="结束日期"
          />
        </el-form-item>
        <el-form-item label="事由">
          <el-input v-model="form.reason" type="textarea" :rows="2" placeholder="生态敏感期 / 执法管控 / 极端海况" maxlength="120" />
        </el-form-item>
        <el-form-item label="发布人">
          <el-input v-model="form.issuer" maxlength="20" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitForm">发布</el-button>
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

.page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
</style>
