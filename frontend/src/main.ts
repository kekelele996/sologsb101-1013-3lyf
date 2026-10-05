import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import zhCn from 'element-plus/es/locale/lang/zh-cn'
import 'element-plus/dist/index.css'
import * as ElementPlusIconsVue from '@element-plus/icons-vue'
import App from '@/App.vue'
import router from '@/router'
import { consumeLegacyBackfillPending, initDatabase } from '@/utils/db'
import { initPatrolDatabase } from '@/utils/patrolDb'
import { isPatrolSeeded, markPatrolSeeded, seedPatrolDemoData, surveyHasBelts } from '@/utils/patrolSeed'
import { backfillLegacyFilings, reconcileBelts } from '@/utils/reconcile'
import '@/styles/main.css'

const app = createApp(App)

Object.entries(ElementPlusIconsVue).forEach(([key, component]) => {
  app.component(key, component)
})

app.use(createPinia())
app.use(router)
app.use(ElementPlus, { locale: zhCn })

app.mount('#app')

/**
 * 启动编排（普查队库与巡护队库各持一份）：
 * 1. 打开普查库（v2→v3 升级时旧样带先挂起并打「待核回填」）；
 * 2. 打开巡护库；
 * 3. 旧库升级：按调查日期向巡护队一侧回填一版报备单（待核），随后全量重判；
 *    全新安装：两侧播种演示数据后全量对账一次。
 */
async function bootstrap(): Promise<void> {
  await initDatabase()
  await initPatrolDatabase()

  const legacyPending = consumeLegacyBackfillPending()
  if (legacyPending) {
    await backfillLegacyFilings()
    await reconcileBelts()
    markPatrolSeeded()
    return
  }

  if (!isPatrolSeeded()) {
    if (await surveyHasBelts()) {
      await seedPatrolDemoData()
      await reconcileBelts()
    }
    markPatrolSeeded()
  }
}

void bootstrap()
