<!--
  文件用途：开启"图片索引"功能的二次开发设计方案 - 方向 B（自实现 VLM 消费者）
  生成日期：2026-07-30（方向 B 定稿）
  源码版本：v4.15.2
  说明：由 designer 子 agent 产出，主 agent 验收落盘；确认后交 implementer 实施
  历史：方向 A（仅去 isPlus）已实施但发现 image/imageParse 消费者在 pro，社区版缺，故改为方向 B
-->

# 开启图片索引功能 - 二开设计方案（方向 B：自实现 VLM 消费者）

## 一、背景与已确认结论

图片索引两条路线：
- **图片向量路线**（`imageEmbedding` 索引）：社区版 `dataIndex.ts:199 getImageEmbeddingSources` 在 `mode=chunk` 下由 `generateVector` 触发，**已可用**。
- **VLM 描述路线**（`image` 索引，VLM 识别图片生成文本描述再向量化）：消费者原属商业版 `pro/admin/src/service/core/dataset/training/imageIndex.ts`（见 `.agents/design/图搜图-当前需求-功能开发文档.md:515`），**社区版缺失**，导致 `mode=image`/`imageParse` 训练任务卡死。

社区版 `createDatasetTrainingMongoWatch`（`training/utils.ts:8-26`）只分发 `qa`/`chunk`/`parse`，无 `image`/`imageParse` 分支。

**已实施（保留）**：
- 后端 `getTrainingModeByCollection`（`collection/utils.ts:226-241`）已去掉 `image`/`imageParse` 分支的 `isPlus` -> 社区版能进 `image`/`imageParse` 模式。
- 前端 `imageIndexConfigState`（`CollectionChunkForm.tsx:138-169`）已去 `isPlus` -> 用户能勾选。

**方向 B 核心工作**：新增社区版 VLM 消费者 `generateImageIndex`，消费 `mode=image`/`imageParse` 任务。

## 二、概述

新增消费者职责：
1. 抢占 `mode=image`/`imageParse` 训练任务。
2. 调用 VLM 识别图片生成文本描述。
3. 把描述挂回 `trainingData`（`imageParse` 写入 `q`；`image` 作为 `type:image` 索引）+ `imageDescMap`。
4. 转 `mode=chunk` 队列，复用 `generateVector` 完成文本向量化与 `imageEmbedding` 补齐。
5. 计费、错误重试、并发控制。

## 三、影响范围

### 新增文件
- `projects/app/src/service/core/dataset/queues/generateImageIndex.ts`：VLM 消费者主体。

### 修改文件
- `projects/app/src/service/core/dataset/training/utils.ts`：`createDatasetTrainingMongoWatch` 加 `image`/`imageParse` 分支；`startTrainingQueue` 加 `generateImageIndex()`。
- `projects/app/src/types/index.ts`：声明 `global.imageQueueLen`。

### 已就绪（无需改）
- 前端 `imageIndexConfigState` 已去 `isPlus`。
- 状态展示 `TrainingStates.tsx`、`trainingStatus.ts`、`TrainingProcess` 已支持 `image`/`imageParse`。
- 入队链路 `getTrainingModeByCollection`、`getDatasetImageTrainingMode`、`insertImages.ts`、`create/images.ts`、`rebuildEmbedding.ts`、`createCollectionAndInsertData` 均能创建 `image`/`imageParse` 任务。
- 计费 enum `UsageItemTypeEnum.training_imageIndex=4`、`training_imageParse=6` 已存在（`packages/global/support/wallet/usage/constants.ts:81/83`）。
- 并发配置 `global.systemEnv.vlmMaxProcess` 已存在（`packages/global/common/system/types/index.ts:176`）。
- `MongoDatasetTraining` schema 已有 `imageId`/`imageDescMap`/`indexes` 字段。
- `getRebuildBaseIndexes`（`generateVector.ts:56-77`）已保留 `image` 索引。
- `formatIndexes`（`dataIndex.ts:334-396`）已把 `image` 索引当外部索引走文本 embedding。
- `pushDataListToTrainingQueue`（`controller.ts:185-201`）**不透传 `imageDescMap`** -> 消费者需直接 `MongoDatasetTraining.create`。

## 四、技术决策

### 4.1 消费者处理流程

```
抢锁 findOneAndUpdate(mode: {$in:[image,imageParse]}, retryCount>0, lockTime<=-10min)
  ↓
populate dataset(vectorModel, vlmModel) + collection(name, indexPrefixTitle, imageIndex)
  ↓
checkTeamAiPointsAndLock
  ↓
getDatasetImageIndexCapability({vectorModel, vlmModel})
  ↓
mode===imageParse（必有 VLM，必有 imageId，无 q）
  ↓ normalizeDatasetIndexImageToModelInput(imageId) -> base64
  ↓ createLLMResponse(useVision) -> 描述 desc
  ↓ 转 chunk：{ imageId, q: desc, imageDescMap: {imageId: desc}, chunkIndex }（无 dataId，走 insertData）
  ↓
mode===image（有 q 含 markdown 图片，可能无 imageId）
  ↓ 无 VLM？直接转 chunk（带原 q/indexes/dataId），跳过 VLM
  ↓ 有 VLM：uniqueDatasetDataMarkdownImageUrls([q]) -> url[]
  ↓ 并行 createLLMResponse(useVision) 每张图 -> desc[]（部分失败跳过）
  ↓ indexes 追加 {type:image, text:desc}[]；imageDescMap = {url: desc}
  ↓ 转 chunk：{ q: 原q, indexes: 原indexes+image索引, imageDescMap, dataId, chunkIndex }（走 rebuildData）
  ↓
mongoSessionRun: MongoDatasetTraining.create([{...mode:chunk, imageDescMap, ...}]) + deleteOne 当前任务
  ↓
pushLLMTrainingUsage（training_imageParse | training_imageIndex）
```

### 4.2 image 索引向量化路径：转 `mode=chunk`（关键决策）

消费者不直接调 `insertVectors`/`updateDatasetDataByIndexes`，而是把 VLM 产物挂回 `trainingData`，创建 `mode=chunk` 任务，由 `generateVector` 完成向量化。

**理由**：
1. 复用 `generateVector` 的 `insertData`/`rebuildData`，它们已通过 `formatIndexes` 把 `image` 索引当外部索引走文本 embedding（`dataIndex.ts:334-396`）。
2. 复用 `imageEmbedding` 补齐：`getImageEmbeddingSources` 从 `q` 的 markdown 图片和 `imageId` 自动生成 `imageEmbedding`，与 VLM 文本索引同批写入。
3. 复用 `getRebuildBaseIndexes` 对 `image` 索引的保留逻辑。
4. 复用计费：`generateVector` 的 `pushGenerateVectorUsage` 统一计文本/image embedding 的 token；消费者只计 VLM 的 LLM token。
5. 与 pro 设计一致（功能开发文档 2.1.9："`imageIndex.ts` 只负责 VLM 文本图片索引，`imageEmbedding` 由后续 `generateVector` 建索引阶段统一补齐"）。
6. 避免 VLM 消费者直接操作 `MongoDatasetData` + 向量库，降低 `dataId` 一致性风险。

### 4.3 `mode=image` 与 `mode=imageParse` 差异处理

| 维度 | `mode=image`（文档 markdown 图片） | `mode=imageParse`（纯图 imageId） |
|---|---|---|
| 触发条件 | `supportImageIndex && hasMarkdownImages`（不要求 VLM） | `supportVlm && imageId`（必有 VLM） |
| `trainingData` 字段 | `q`（含 markdown 图片）、`indexes`、`dataId`（重建） | `imageId`、无 `q`、无 `dataId` |
| VLM 输入 | `q` 中提取的 markdown 图片 URL 逐张 | `imageId` |
| VLM 产物落点 | `type:image` 索引（每张图一条），保留原 `q` | `q`（描述即数据正文） |
| `imageDescMap` | `{url: desc}` | `{imageId: desc}` |
| 转 chunk 带 `dataId` | 是（走 `rebuildData`） | 否（走 `insertData`） |
| 无 VLM 降级 | 直接转 chunk（`generateVector` 只生成 `imageEmbedding`） | 不会出现 |

- **`imageParse` 把 VLM 描述设为 `q`**：纯图数据无文档正文，VLM 描述就是数据内容；让 `default` 文本索引检索到图片描述，与 `imageEmbedding` 图片向量索引双路命中。
- **`image` 把 VLM 描述作为 `image` 索引（不覆盖 `q`）**：文档分块 `q` 必须保留以供 `imageEmbedding` 从 markdown 图片提取 URL；VLM 描述作为独立 `image` 索引，与 `default`（文本）、`imageEmbedding`（图片向量）三路并存。

### 4.4 VLM 调用方式（参考 `imageCaption.ts`）

- 模型获取：`getVlmModel(vlmModel)`（`packages/service/core/ai/model.ts:27-30`）。
- 校验：`availableVlmModel?.vision`（防御性）。
- 图片归一化：复用 `dataIndex.ts:153-163 normalizeDatasetIndexImageToModelInput`（支持 S3 key `dataset`/`temp`/`chat` 与 http(s) URL）。
- 调用：`createLLMResponse({ teamId, saveLLMResponseRecord: false, body: { model, stream: true, useVision: true, messages: [{role:'user', content:[{type:'image_url', image_url:{url: base64}}, {type:'text', text: prompt}]}] } })`。
- prompt（训练场景）：
  - `imageParse`：`请详细描述这张图片的内容，包括主体、场景、颜色、可见文字和关键视觉特征。输出一段简洁的中文描述，不要解释。`
  - `image`：同上简化版（不含文档上下文；pro 的"上下文影响"为商业版行为，社区版简化）。
- 错误降级：单张图 VLM 失败 -> `warn` 日志 + 跳过该图；全部失败 -> 抛错走 `errorMsg` 重试。

### 4.5 并发控制、锁与重试

- 并发计数：`global.imageQueueLen`（新增），上限 `global.systemEnv?.vlmMaxProcess || 5`（VLM 慢且占资源，默认 5）。
- `reduceQueue` 模式同 `generateQA`/`generateVector`。
- 抢锁条件：`mode: {$in:[image,imageParse]}, retryCount: {$gt:0}, lockTime: {$lte: addMinutes(now,-10)}`，`$set lockTime, $inc retryCount:-1`。锁时间 `-10min`（VLM 是 LLM 调用，参考 `generateQA`/`datasetParseQueue`）。
- 重试：`retryCount` 入队时 5（新建）/ 50（重建），消费者每次 `$inc:-1`，耗尽后带 `errorMsg` 停留。
- 错误处理：`catch` 写 `errorMsg`，`delay(100)`，不删任务（等重试或人工处理）。

### 4.6 计费

- VLM 调用：`pushLLMTrainingUsage`，`type` 用 `UsageItemTypeEnum.training_imageParse`（imageParse）或 `training_imageIndex`（image）。
- 文本/image embedding 向量化：由 `generateVector` 的 `pushGenerateVectorUsage` 统一计费，消费者不重复计。
- `inputTokens`/`outputTokens` 来自 `createLLMResponse` 的 `usage`；`model` 用 `availableVlmModel.model`。

### 4.7 注册到 watch + startTrainingQueue

- `createDatasetTrainingMongoWatch`：`insert` 事件 `mode` 分支增加 `image`/`imageParse` -> `generateImageIndex()`。
- `startTrainingQueue`：循环体增加 `generateImageIndex()`。

### 4.8 前端 `imageIndexConfigState`

已去 `isPlus`，按 `vectorModel.vision` + `vlmModel` 组合控制。方向 B 下无需调整：有 VLM 或多模态 embedding 即可启用 `imageIndex`，与后端 `getDatasetImageIndexCapability` 一致。

## 五、实施步骤

### 5.1 新增 `projects/app/src/service/core/dataset/queues/generateImageIndex.ts`

骨架（关键签名 + 注释，implementer 填充实现）：

```ts
/**
 * VLM 图片索引消费者。
 *
 * 职责：消费 mode=image / mode=imageParse 训练任务，调用 VLM 识别图片生成文本描述，
 * 把描述挂回 trainingData（image 索引或 q）后转入 mode=chunk 队列，
 * 由 generateVector 完成文本向量化与 imageEmbedding 补齐。
 *
 * - imageParse（纯图）：VLM 描述写入 q，保留 imageId，转 chunk 走 insertData。
 * - image（文档 markdown 图片）：VLM 描述作为 type:image 索引，保留原 q，转 chunk 走 rebuildData。
 * - 无 VLM 时（仅 image 模式可能）：直接转 chunk，跳过 VLM，由 generateVector 生成 imageEmbedding。
 */

// 复用 dataIndex 的图片归一化（支持 S3 key）
import { normalizeDatasetIndexImageToModelInput } from '@/service/core/dataset/data/dataIndex';

const reduceQueue = () => {
  global.imageQueueLen = global.imageQueueLen > 0 ? global.imageQueueLen - 1 : 0;
  return global.imageQueueLen === 0;
};

type PopulateType = {
  dataset: { vectorModel: string; vlmModel?: string };
  collection: { name: string; indexPrefixTitle: boolean; imageIndex?: boolean };
};

/**
 * 调用 VLM 识别单张图片生成文本描述。
 * 失败时返回空字符串，由调用方决定降级策略。
 */
const describeImageByVlm = async (params: {
  teamId: string;
  vlmModel: string;          // 已校验 vision 的 model id
  imageUrl: string;          // imageId 或 markdown 图片 URL
}): Promise<{ desc: string; inputTokens: number; outputTokens: number }>;

/**
 * 处理 mode=imageParse 任务：纯图数据，VLM 描述作为 q。
 * 返回待入队的 chunk 任务数据（无 dataId，走 insertData）。
 */
const handleImageParse = async (trainingData: TrainingDataType) => {
  // 1. getDatasetImageIndexCapability 校验 VLM（imageParse 必有 VLM，防御性）
  // 2. describeImageByVlm(imageId) -> desc
  // 3. 返回 { q: desc, imageId, imageDescMap: {imageId: desc}, chunkIndex }
};

/**
 * 处理 mode=image 任务：文档 markdown 图片，VLM 描述作为 image 索引。
 * 返回待入队的 chunk 任务数据（带 dataId，走 rebuildData）。
 */
const handleImage = async (trainingData: TrainingDataType) => {
  // 1. getDatasetImageIndexCapability
  //    - 无 VLM：直接返回 { q: trainingData.q, indexes: trainingData.indexes, dataId } 转 chunk
  //    - 有 VLM：继续
  // 2. uniqueDatasetDataMarkdownImageUrls([trainingData.q]) -> url[]
  // 3. 并行 describeImageByVlm(url) -> desc[]（部分失败跳过）
  // 4. 追加 image 索引：desc.map(d => ({type: image, text: d}))
  // 5. 返回 { q: trainingData.q, indexes: [...原indexes, ...image索引], imageDescMap, dataId }
};

export async function generateImageIndex(): Promise<any> {
  // 结构同 generateQA.ts:37-220：
  // 1. global.imageQueueLen + vlmMaxProcess 并发闸门
  // 2. while(true): findOneAndUpdate 抢锁（mode: {$in:[image,imageParse]}, -10min）
  // 3. populate dataset/collection
  // 4. checkTeamAiPointsAndLock
  // 5. mode===imageParse ? handleImageParse : handleImage
  // 6. mongoSessionRun: MongoDatasetTraining.create([{...mode:chunk, imageDescMap, q, indexes, imageId, dataId, chunkIndex}]) + deleteOne 当前任务
  //    注意：不调 pushDataListToTrainingQueue（它不透传 imageDescMap），直接 create
  // 7. pushLLMTrainingUsage(type: training_imageParse | training_imageIndex)
  // 8. catch: updateOne errorMsg, delay(100)
  // 9. reduceQueue
}
```

**关键实现要点**：
- `findOneAndUpdate` 用 `mode: { $in: [TrainingModeEnum.image, TrainingModeEnum.imageParse] }`，一个消费者处理两种模式。
- 创建 chunk 任务时**直接 `MongoDatasetTraining.create`**（不调 `pushDataListToTrainingQueue`），以携带 `imageDescMap`；参考 `rebuildEmbedding.ts:156-184` 和 `generateVector.ts:281-306` 的直接 create 模式。
- chunk 任务字段：`teamId/tmbId/datasetId/collectionId/billId/mode:chunk/model:vectorModel/q/a/imageId/chunkIndex/indexSize/indexes/imageDescMap/dataId?/retryCount:5`。
- `image` 模式转 chunk 必须带 `q`（原 markdown 文本）+ `indexes`（含新 image 索引）+ `dataId`。
- `imageParse` 模式转 chunk 带 `imageId` + `q=desc`，无 `dataId`。

### 5.2 修改 `projects/app/src/service/core/dataset/training/utils.ts`

**`createDatasetTrainingMongoWatch`** before（L16-22）：
```ts
if (mode === TrainingModeEnum.qa) {
  generateQA();
} else if (mode === TrainingModeEnum.chunk) {
  generateVector();
} else if (mode === TrainingModeEnum.parse) {
  datasetParseQueue();
}
```
after：
```ts
if (mode === TrainingModeEnum.qa) {
  generateQA();
} else if (mode === TrainingModeEnum.chunk) {
  generateVector();
} else if (mode === TrainingModeEnum.parse) {
  datasetParseQueue();
} else if (mode === TrainingModeEnum.image || mode === TrainingModeEnum.imageParse) {
  // VLM 图片描述索引消费者：识别图片生成文本描述，再转 chunk 向量化
  generateImageIndex();
}
```
顶部 import 加 `import { generateImageIndex } from '../queues/generateImageIndex';`。

**`startTrainingQueue`** before（L31-35）：
```ts
for (let i = 0; i < (fast ? max : 1); i++) {
  generateQA();
  generateVector();
  datasetParseQueue();
}
```
after：
```ts
for (let i = 0; i < (fast ? max : 1); i++) {
  generateQA();
  generateVector();
  datasetParseQueue();
  generateImageIndex();
}
```

### 5.3 修改 `projects/app/src/types/index.ts`

before（L3-6）：
```ts
declare global {
  var qaQueueLen: number;
  var vectorQueueLen: number;
  var datasetParseQueueLen: number;
```
after：
```ts
declare global {
  var qaQueueLen: number;
  var vectorQueueLen: number;
  var datasetParseQueueLen: number;
  // VLM 图片索引消费者并发计数
  var imageQueueLen: number;
```

## 六、测试点

### 6.1 功能验证
1. **配置 VLM**：模型配置页配置一个 `vision=true` 的 LLM 作为某知识库的 `vlmModel`。
2. **纯图集合（imageParse）**：创建图片集合，上传 3 张图片。
   - 验证：`MongoDatasetTraining` 出现 `mode=imageParse` 任务 -> 被消费 -> 出现 `mode=chunk` 任务 -> 被 `generateVector` 消费 -> `MongoDatasetData` 生成。
   - 验证 `data.q` 为 VLM 描述，`data.imageDescMap[imageId]` 存在，`data.indexes` 含 `default` + `imageEmbedding`。
   - 验证 VLM 计费记录（`training_imageParse`）。
3. **文档集合开启图片索引（image）**：导入含 markdown 图片的文档，开启图片自动索引，配置 VLM + 多模态 embedding。
   - 验证：`mode=image` 任务被消费 -> `mode=chunk` 任务 -> `data.indexes` 含 `default` + `image`（VLM 描述文本向量）+ `imageEmbedding`（图片向量）。
   - 验证 `data.imageDescMap[url]` 存在。
4. **文档集合无 VLM（image 降级）**：多模态 embedding + 无 VLM。
   - 验证：`mode=image` 任务被消费 -> 直接转 chunk -> `data.indexes` 含 `default` + `imageEmbedding`，**无** `image` 索引。
5. **检索命中**：文本 query 搜索命中 VLM 描述索引；图片 query 搜索命中 `imageEmbedding`。
6. **重建**：切换索引模型触发 `rebuildEmbedding`，验证 `image`/`imageParse` 重建任务正常流转。

### 6.2 回归
- `mode=chunk`（普通文本集合）导入/重建不受影响。
- `mode=qa`、`mode=parse` 不受影响。
- 无 VLM 的普通知识库不产生 `image`/`imageParse` 任务。

### 6.3 错误场景
- VLM 调用失败：任务 `errorMsg` 写入，`retryCount` 递减，重试到 0 后停留为最终错误。
- VLM 部分图片失败（image 模式多图）：成功图片生成 `image` 索引，失败图片跳过，任务仍完成转 chunk。
- 团队 AI 点数不足：`checkTeamAiPointsAndLock` 锁定任务，不扣点。

## 七、风险与回滚

### 7.1 风险

| 风险 | 影响 | 应对 |
|---|---|---|
| VLM 调用慢/超时 | 任务长时间占用锁 | 锁时间 `-10min` 兜底；`vlmMaxProcess` 默认 5 限并发；`createLLMResponse` 支持超时 |
| 与 `generateVector` 协作死循环 | image -> chunk -> image 循环 | 不会发生：消费者只创建 `mode=chunk`；`rebuildData` 重建时若 data 含 markdown 图片会再创 `image` 任务，但 image 消费者最终转 chunk 并删除 image 任务，是正常重建流程非死循环 |
| `imageDescMap` 透传缺失 | 展示态 alt 回填失效 | 消费者直接 `MongoDatasetTraining.create` 携带 `imageDescMap` |
| `image` 模式无 VLM 降级丢索引 | 仅 `imageEmbedding` 无 VLM 文本索引 | 符合设计：无 VLM 时不生成 VLM 文本索引 |
| VLM prompt 不含文档上下文 | 描述质量略低于 pro | 社区版简化，可后续优化 |
| 计费类型误用 | 账单统计偏差 | `imageParse` 用 `training_imageParse`，`image` 用 `training_imageIndex` |

### 7.2 回滚
1. 注释 `utils.ts` 中 `generateImageIndex()` 调用（watch + startTrainingQueue），`image`/`imageParse` 任务恢复卡死状态（不影响已入库数据）。
2. 删除 `generateImageIndex.ts`。
3. 卡死任务可手动删除或改为 `chunk` 模式让 `generateVector` 直接处理（仅多模态 embedding 场景）。
4. 已入库的 `image`/`imageEmbedding` 索引仍可正常检索。

## 八、相关文件路径

- **新增**：`projects/app/src/service/core/dataset/queues/generateImageIndex.ts`
- **修改**：`projects/app/src/service/core/dataset/training/utils.ts`、`projects/app/src/types/index.ts`
- **已改（保留）**：`packages/service/core/dataset/collection/utils.ts`、`projects/app/src/pageComponents/dataset/detail/Form/CollectionChunkForm.tsx`
- **参考**：`projects/app/src/service/core/dataset/queues/generateQA.ts`、`generateVector.ts`（消费者结构）；`packages/service/core/dataset/search/defaultRecall/imageCaption.ts`（VLM 调用）；`projects/app/src/service/core/dataset/data/dataIndex.ts`（`normalizeDatasetIndexImageToModelInput`、`formatIndexes`）；`.agents/design/图搜图-当前需求-功能开发文档.md`（pro 设计参考）

---

## 九、实施状态

- **已实施**（2026-07-30，方向 B）：
  - 新增 `projects/app/src/service/core/dataset/queues/generateImageIndex.ts`（VLM 消费者，完整实现 `describeImageByVlm`/`handleImageParse`/`handleImage`/`generateImageIndex`）。
  - 修改 `training/utils.ts`（注册到 `createDatasetTrainingMongoWatch` + `startTrainingQueue`）、`types/index.ts`（声明 `imageQueueLen`）、`dataIndex.ts`（导出 `normalizeDatasetIndexImageToModelInput` 供复用，仅加 `export` 无逻辑改动）。
  - ESLint 0 error（1 warning 为原有空 catch，非本次）。
- **实现决策**：chunk 任务不设 `expireAt`/`model`（用 schema 默认，与 `controller.ts` 直接 create 模式一致，`generateVector` 读 `dataset.vectorModel` 不依赖 `training.model`）；`pushLLMTrainingUsage` 按实际签名无 `tmbId`；计费仅在 `inputTokens+outputTokens>0` 时调用。
- **已运行时验证通过**（2026-07-31）：配置 qwen3-vl-plus（VLM）+ qwen3-embedding:0.6b（向量模型，不支持 vision）+ Doc2X 解析 PDF。导入含图片 PDF（勾选图片自动索引）：`getTrainingModeByCollection` 返回 image（三条件满足，isPlus=false 不再拦截）-> `generateImageIndex` 消费 -> VLM 调用（qwen3-vl-plus，1191 input + 190 output tokens）-> 转 chunk -> `generateVector` 入库。13 条数据中 2 条含图片，`indexes` 含 `type:image`（VLM 描述）+ `type:default`（文本）。文本搜索可命中图片描述。`imageEmbedding` 因向量模型不支持 vision 未生成（符合预期，需 `vision=true` 向量模型）。
- **类型检查**：service tsc 零报错（预存测试文件 TS2307 无关）；app tsc 因 OOM 未跑完，建议 `NODE_OPTIONS=--max-old-space-size=4096 pnpm lint` 复核。
- **回滚**：注释 `utils.ts` 中 `generateImageIndex()` 调用 + 删除 `generateImageIndex.ts` 即可。
