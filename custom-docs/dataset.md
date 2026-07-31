<!--
  文件用途：FastGPT 知识库(dataset)模块前后端架构、文件与方法梳理，供二次开发导航
  生成日期：2026-07-29
  源码版本：v4.15.2（fork 自 labring/FastGPT）
  说明：本文档为本 fork 二次开发梳理产物，存放于 custom-docs/，与上游 .agents/ 隔离
-->

# FastGPT 知识库（dataset）模块梳理

> 基于 v4.15.2 源码，对约 200 个文件深度梳理后综合。覆盖前后端 5 层结构、文件清单、关键方法与两条核心业务链路。

## 一、分层架构与前后端搭配总览

知识库模块是 **5 层结构**，前后端通过 NextJS API 路由衔接，共享类型层双端复用：

```
[浏览器]  L5 页面组件  pageComponents/dataset/         (React 页面/交互)
              │ 调用
[浏览器]  L4 前端封装  web/core/dataset/api/*            (请求封装) + store/context (状态)
              │ HTTP  /api/core/dataset/**
[服务端]  L3 API 路由  pages/api/core/dataset/           (鉴权+校验+编排，NextAPI)
              │ 调用
[服务端]  L2 后端业务  packages/service/core/dataset/   (controller/utils/schema + BullMQ 队列)
              │ 读写
[服务端]  L1 共享契约  packages/global/core/dataset/    (zod schema + 枚举 + 纯函数，前后端共用)
              │
         MongoDB(datasets/dataset_collections/dataset_datas/dataset_data_texts/dataset_trainings/...) + 向量库(pgvector/Milvus) + S3
```

**搭配要点**：L1 双端共享同一份 zod schema 与枚举，避免类型漂移；L4 的 `api/*.ts` 与 L3 路由 URL 一一对应；L3 路由很薄（只做 `parseApiInput` 校验 + `authDataset/authDatasetCollection/authDatasetData` 鉴权 + 编排），业务逻辑全在 L2；L2 通过 `recallFromVectorStore`/`deleteDatasetDataVector` 与外部向量库交互（存储后端无关）。注意 `projects/app/src/service/core/dataset/queues/` 虽在 app 工程下，但**是服务端后台 worker**（训练队列消费者），不是浏览器代码。

---

## 二、MongoDB 数据模型一览

| 集合 | Model（schema.ts 位置） | 用途 |
|---|---|---|
| `datasets` | `MongoDataset`（根 schema.ts） | 知识库主表，含 parentId 父子结构、向量/agent/vlm 模型、chunkSettings、软删除 deleteTime、apiDatasetServer、autoSync |
| `dataset_collections` | `MongoDatasetCollection`（collection/schema.ts） | 文档集合（一个上传文件/链接/API 文件 = 一个 collection），含 type/tags/fileId/rawLink/metadata/forbid/chunkSettings |
| `dataset_datas` | `MongoDatasetData`（data/schema.ts） | 数据块/chunk，含 q/a/imageId/imageDescMap/history/indexes/chunkIndex/rebuilding |
| `dataset_data_texts` | `MongoDatasetDataText`（data/dataTextSchema.ts） | 全文检索 token（Mongo text 索引 + jieba 分词，供 fullTextRecall） |
| `dataset_trainings` | `MongoDatasetTraining`（training/schema.ts） | 训练队列，含 mode/expireAt(7天TTL)/lockTime/retryCount/q/a/indexes/errorMsg |
| `dataset_collection_tags` | `MongoDatasetCollectionTags`（tag/schema.ts） | 集合标签 |
| `dataset_image.files` | `MongoDatasetImageSchema`（image/schema.ts） | GridFS 图片桶（VLM/图片向量用） |
| `dataset_migration_logs` | `MongoDatasetMigrationLog`（migration/schema.ts） | GridFS->S3 迁移日志 |

---

## 三、各层文件与方法清单

### L1 共享契约层 `packages/global/core/dataset/`（13 文件，前后端共用）

| 文件 | 职责 | 关键导出 |
|---|---|---|
| `constants.ts` | 全局枚举与 i18n/图标映射 | `DatasetTypeEnum`、`DatasetCollectionTypeEnum`、`TrainingModeEnum`(parse/imageParse/qa/image/auto/chunk)、`DatasetSearchModeEnum`、`SearchScoreTypeEnum`、`DatasetCollectionDataProcessModeEnum`、`DatasetTypeMap` 等 |
| `type.ts` | zod schema + 派生 DTO（数据契约核心） | `DatasetSchema`/`DatasetItemSchema`、`DatasetCollectionSchema`、`DatasetDataSchema`/`DatasetDataTextSchema`、`DatasetTrainingSchema`、`SearchDataResponseItemSchema`/`DatasetCiteItemSchema`、`ChunkSettingsSchema` 等（均配 `z.infer` 类型） |
| `utils.ts` | 图标/来源纯函数 | `getCollectionIcon`、`getSourceNameIcon`、`predictDataLimitLength`、`isDatasetFileObjectKey` |
| `collaborator.ts` | 协作者请求体类型 | `UpdateDatasetCollaboratorBody`、`DatasetCollaboratorDeleteParams` |
| `apiDataset/type.ts` | 第三方 API 数据集配置 | `APIFileItemSchema`、`FeishuServerSchema`、`YuqueServerSchema`、`DingtalkServerSchema`、`ApiDatasetServerSchema` |
| `apiDataset/utils.ts` | 敏感字段脱敏 | `filterApiDatasetServerPublicData` |
| `collection/constants.ts` | sourceId 前缀 | `CollectionSourcePrefixEnum`、`RootCollectionId` |
| `collection/utils.ts` | 集合来源/类型判断 | `getCollectionSourceData`、`checkCollectionIsFolder`、`collectionCanSync` |
| `data/constants.ts` | 索引类型 | `DatasetDataIndexTypeEnum`、`DatasetDataIndexMap`、`getDatasetIndexMapData` |
| `data/utils.ts` | 系统索引判定 | `isDatasetDataSystemIndexType`、`datasetDataSystemIndexTypes` |
| `image/type.ts` | 图片元数据类型 | `DatasetImageSchema` |
| `search/utils.ts` | RRF 多路融合 | `datasetSearchResultConcat`（权重 `1/(60+rank)`） |
| `training/utils.ts` | 分块参数计算（唯一直接依赖 service 层模型注册表） | `getMaxChunkSize`、`getLLMDefaultChunkSize`、`getMaxIndexSize`、`getIndexSizeSelectList`、`computedCollectionChunkSettings` |

### L2 后端业务层 `packages/service/core/dataset/`（41 文件，核心）

**根目录**

| 文件 | 职责 | 关键方法 |
|---|---|---|
| `controller.ts` | 递归查询/级联删除入口 | `findDatasetAndAllChildren`、`getCollectionWithDataset`、`delDatasetRelevantData`（删除链路核心） |
| `read.ts` | 来源文本读取与切分 | `readFileRawTextByUrl`、`readDatasetSourceRawText`（4 种来源分流）、`readApiServerFileContent`、`rawText2Chunks` |
| `utils.ts` | S3 预览 URL 替换 + 图片能力判定 | `replaceS3KeysToPreviewUrls`、`getS3ObjectKeysFromMarkdownTexts`、`filterDatasetsByTmbId`、`getDatasetImageIndexCapability`、`getDatasetImageTrainingMode` |

**collection/**（集合增删改查与同步）

| 文件 | 关键方法 |
|---|---|
| `controller.ts` ⭐ | `createCollectionAndInsertData`（入库主入口：切块->定模式->`pushDataListToTrainingQueue`）、`createOneCollection`、`delCollection`、`delCollectionRelatedSource` |
| `utils.ts` | `findCollectionAndChild`、`createOrGetCollectionTags`、`syncCollection`（hash 对比重建）、`getTrainingModeByCollection`（**训练模式分流核心**：imageParse/qa/image/auto/chunk） |
| `mq.ts` | `initCollectionUpdateWorker`、`pushCollectionUpdateJob`（BullMQ 5s 防抖） |
| `schema.ts` | `MongoDatasetCollection` |

**training/**（训练入队与状态）

| 文件 | 关键方法 |
|---|---|
| `controller.ts` ⭐ | `pushDataListToTrainingQueue`（**入队核心**，按 mode 选模型/分批 insertMany）、`pushDatasetToParseQueue`、`lockTrainingDataByTeamId`（积分不足锁定） |
| `query.ts` | `isActiveTraining`/`isFinalErrorTraining`/`isRemainingTraining`、`getSlowestTrainingMode`、`getSlowestTrainingStatus`、`finalErrorTrainingMatch` |
| `schema.ts` | `MongoDatasetTraining` |

**search/**（检索，⭐第二条核心链路）

| 文件 | 关键方法 |
|---|---|
| `index.ts` ⭐ | `defaultSearchDatasetData`（入口：query 扩展->`searchDatasetData`）、`deepRagSearch` |
| `utils.ts` | `computeFilterIntersection`、`datasetSearchQueryExtension`（LLM query 扩展）、`normalizeImageToBase64` |
| `defaultRecall/index.ts` ⭐ | `searchDatasetData`（8 步流水线主流程） |
| `defaultRecall/embeddingRecall.ts` | `embeddingRecall`（向量召回，text/imageCaption/image 三组） |
| `defaultRecall/fullTextRecall.ts` | `fullTextRecall`（Mongo `$text` + jieba） |
| `defaultRecall/multiQueryRecall.ts` | `multiQueryRecall`（并行调度 embedding+fullText） |
| `defaultRecall/rerank.ts` | `reRankSearchResults`（文本精排，失败降级） |
| `defaultRecall/imageCaption.ts` | `getImageCaptionQueries`（VLM 图片->文本 query） |
| `defaultRecall/collectionFilter.ts` | `getForbidCollectionIdList`、`filterCollectionByMetadata`（Plus） |
| `defaultRecall/result.ts` | `buildSearchResultItem`、`concatRecallLists`/`concatWeightedRecallLists`（RRF）、`removeDuplicateSearchResults`、`filterSearchResultsByScore` |
| `defaultRecall/utils.ts` | `countRecallLimit`、`filterDatasetDataByMaxTokens` |

**data/**（数据条目）

| 文件 | 关键方法 |
|---|---|
| `controller.ts` | `formatDatasetDataValues`/`formatDatasetDataValue`、`formatDatasetDataTextValue`、`getFormatDatasetCiteList`（S3 预览 URL 签发） |
| `utils.ts` | `matchDatasetDataMarkdownImages`、`uniqueDatasetDataMarkdownImageUrls` |
| `schema.ts` | `MongoDatasetData` |
| `dataTextSchema.ts` | `MongoDatasetDataText` |

**delete/**（删除链路）

| 文件 | 关键方法 |
|---|---|
| `index.ts` | `initDatasetDeleteWorker`、`addDatasetDeleteJob`（串行+指数退避） |
| `processor.ts` ⭐ | `deleteDatasetsImmediate`、`deleteTeamAllDatasets`、`datasetDeleteProcessor` |

**apiDataset/**（外部知识库适配，均返回 `{listFiles,getFileContent,getFilePreviewUrl,getFileDetail,getFileRawId}`）

| 文件 | 适配器工厂 |
|---|---|
| `index.ts` | `getApiDatasetRequest`（按类型分发） |
| `custom/api.ts` | `useApiDatasetRequest`（自建 `/v1/file/*`） |
| `feishuDataset/api.ts` | `useFeishuDatasetRequest`（自动注入 tenant_access_token） |
| `yuqueDataset/api.ts` | `useYuqueDatasetRequest` |
| `dingtalkDataset/api.ts` | `useDingtalkDatasetRequest`（token Redis 缓存+限流重试） |

**datasetSync/**、**image/**、**tag/**、**migration/**

| 文件 | 关键方法 |
|---|---|
| `datasetSync/index.ts` | `addDatasetSyncJob`、`upsertDatasetSyncJobScheduler`（每天定时）、`reconcileDatasetSyncSchedulers`、`getDatasetSyncDatasetStatus` |
| `image/controller.ts` | `getDatasetImageReadData`（GridFS 流） |

### L3 API 路由层 `projects/app/src/pages/api/core/dataset/`（64 文件）

统一模式：`export default NextAPI(handler)` + `parseApiInput({req,bodySchema,querySchema})` + 四级鉴权 `authUserPer/authDataset/authDatasetCollection/authDatasetData`。URL 与目录一一对应。下表按目录汇总（方法按 query=GET、body=POST、query 删除=DELETE 推断）：

| 目录 | 路由（节选） | 职责 |
|---|---|---|
| 根 | `create`、`createWithFiles`、`delete`、`detail`、`update`、`list`、`paths`、`searchTest`、`exportAll`、`getPermission`、`resumeInheritPermission` | 知识库本体 CRUD + 检索测试 + 流式导出 |
| `apiDataset/` | `list`、`listExistId`、`getCatalog`、`getPathNames` | 外部 API 数据源代理 |
| `collection/` | `create`、`delete`、`detail`、`update`、`listV2`、`list`(@deprecated)、`scrollList`(@deprecated)、`paths`、`read`、`sync`、`trainingDetail`、`export` | 集合增删改查 + 同步 + 训练明细 |
| `collection/create/` | `fileId`、`localFile`、`link`、`text`、`images`、`apiCollection`、`apiCollectionV2`、`backup`、`template`、`reTrainingCollection` | 按来源建集合（multer 上传类走 multipart） |
| `data/` | `list`(@deprecated->v2)、`v2/list`、`detail`、`insertData`、`insertImages`、`pushData`、`update`、`delete`、`getQuoteData` | chunk 数据增删改查 |
| `data/index/` | `create`、`update`、`delete` | 数据级索引管理（重向量化计费） |
| `file/` | `getPreviewChunks`、`getRawTextPreviewChunks`、`presignDatasetFilePostUrl`、`presignSearchTestImage`、`getSearchTestImagePreviewUrls` | 分块预览 + S3 预签名 |
| `folder/` | `create` | 文件夹（含深度/配额校验） |
| `training/` | `getDatasetTrainingQueue`、`getTrainingError`、`getDatasetTrainingError`、`hasDatasetTrainingError`、`getTrainingDataDetail`、`updateTrainingData`、`deleteTrainingData`、`rebuildEmbedding` | 训练队列/错误/重试/重建向量 |

> 计费点统一调 `push*Usage`/`createTrainingUsage`；`collection/read`、`collection/export`、`data/getQuoteData` 额外支持 `authChatTargetCrud` 供聊天中展示引用源。多数路由同时开 `authToken`+`authApiKey`（前端 cookie 与外部 OpenAPI/工作流均可调）。

### L4 前端请求封装与状态层 `projects/app/src/web/core/dataset/` + `src/service/core/dataset/`

**请求封装（web/core/dataset/api/，方法名 -> 后端 URL）**

| 文件 | 关键方法（-> URL） |
|---|---|
| `api.ts` | `getDatasets`->list、`getDatasetById`->detail、`postCreateDataset`->create、`putDatasetById`->update、`delDatasetById`->delete、`postSearchText`->searchTest、`postDatasetSync`->proApi/datasetSync、`getDatasetPermission`、`resumeInheritPer`、`postCreateDatasetFolder` |
| `api/collection.ts` | `getDatasetCollections`->listV2、`getDatasetCollectionById`->detail、`putDatasetCollectionById`->update、`delDatasetCollectionById`->delete、`postLinkCollectionSync`->sync、`getDatasetCollectionTrainingDetail`、`postCreateDatasetFileCollection`->create/fileId、`postCreateDatasetLinkCollection`、`postCreateDatasetTextCollection`、`postCreateDatasetApiDatasetCollection`->apiCollectionV2、`postBackupDatasetCollection`、`postTemplateDatasetCollection`、`postReTrainingDatasetFileCollection`、标签系列（走 proApi/tag/*）、`getCollectionSource`->read |
| `api/data.ts` | `getDatasetDataList`->v2/list、`getDatasetDataItemById`->detail、`postInsertData2Dataset`->insertData、`putDatasetDataById`->update、`delOneDatasetDataById`->delete、`createDatasetDataIndex`/`updateDatasetDataIndex`/`deleteDatasetDataIndex`->index/*、`getQuoteData` |
| `api/training.ts` | `postRebuildEmbedding`、`getDatasetTrainingQueue`、`deleteTrainingData`、`updateTrainingData`、`getTrainingError`、`getDatasetTrainingError`、`hasDatasetTrainingError`、`getTrainingDataDetail` |
| `api/file.ts` | `getUploadDatasetFilePresignedUrl`、`getPreviewChunks`、`getRawTextPreviewChunks`、`getUploadSearchTestImagePresignedUrl`、`postGetSearchTestImagePreviewUrls` |
| `api/apiDataset.ts` | `getApiDatasetFileList`、`getApiDatasetFileListExistId`、`getApiDatasetCatalog`、`getApiDatasetPaths` |
| `api/collaborator.ts` | `getCollaboratorList`、`postUpdateDatasetCollaborators`、`deleteDatasetCollaborators`（均 proApi） |
| `image/api.ts` | `createImageDatasetCollection`->create/images、`insertImagesToCollection`->insertImages（FormData 带进度） |

**状态管理**

| 文件 | 类型 | 内容 |
|---|---|---|
| `store/dataset.ts` | Zustand | `useDatasetStore`：`myDatasets` + `loadMyDatasets` |
| `store/searchTest.ts` | Zustand(persist) | `useSearchTestStore`：检索测试历史（≤50 条） |
| `store/markdata.ts` | Zustand | `useSearchTestStore`：标注编辑态（注意与上同名） |
| `context/datasetPageContext.tsx` | React Context | 详情页中枢：`datasetDetail`/`loadDatasetDetail`/`updateDataset`、`paths`、`trainingCount`/`rebuildingCount`（10s 轮询）、标签全集 |
| `context/datasetsContext.tsx` | React Context | 占位（空） |
| `hooks/readCollectionSource.ts` | hook | `getCollectionSourceAndOpen` |
| `constants.ts` | 常量 | `defaultDatasetDetail`、`TrainingProcess` |
| `trainingStatus.ts` | 工具 | `getTrainingStageText`、`getCollectionTrainingStatusText`、`getCollectionTrainingStatusColorSchema` |
| `type.ts` | 类型 | `ImportSourceItemType`、`ImportSourceParamsType` |
| `components/SelectCollections.tsx` | 组件 | 集合/文件夹选择弹窗 |

**服务端后台 worker（projects/app/src/service/core/dataset/，训练队列消费者）**

| 文件 | 职责 |
|---|---|
| `queues/datasetParse.ts` | `datasetParseQueue()`：消费 `mode=parse`，读原文->LLM 段落->`rawText2Chunks`->推 chunk 队列 |
| `queues/generateQA.ts` | `generateQA()`：消费 `mode=qa`，LLM 生成 Q/A->推 chunk 队列 |
| `queues/generateVector.ts` | `generateVector()`：消费 `mode=chunk`，`insertData`/`rebuildData` 写 `MongoDatasetData`+向量库；`getRebuildBaseIndexes` |
| `queues/utils.ts` | `checkTeamAiPointsAndLock`（积分不足锁团队训练） |
| `training/utils.ts` | `createDatasetTrainingMongoWatch`（Change Stream 按 mode 分发）、`startTrainingQueue` |
| `data/data.ts` | `DatasetDataOperation` 类（create/updateByIndexes/updateSystemIndexes/delete）、`createDatasetData`、`updateDatasetDataByIndexes`（多存储一致性：向量->Mongo->dataText->S3） |
| `data/dataIndex.ts` | `DatasetDataIndexOperation` 类（系统索引生成/patch diff/向量写删）、`createDatasetDataIndex`/`updateDatasetDataIndex`/`deleteDatasetDataIndex` |
| `data/utils.ts` | `hasSameValue`（去重校验） |

### L5 前端页面组件层 `projects/app/src/pageComponents/dataset/`（61 文件）

两级页面：`list/` 列表页 -> `detail/` 详情页（NavBar 路由 3 Tab + 2 子视图）。

| 目录 | 职责 | 关键组件 |
|---|---|---|
| 根 | 通用弹窗 | `ApiDatasetForm`（外部 API 配置，复用）、`EditFolderModal`+`useEditFolder`、`MemberManager`（协作者） |
| `list/` | 知识库列表页 | `List`（卡片网格+拖拽移动）、`CreateModal`（新建）、`SideTag`、`commercialDatasetTypes`、`context`（`DatasetsContext`） |
| `detail/` | 详情页容器+数据视图 | `NavBar`（Tab 路由）、`DataCard`（集合内 chunk 列表）、`MetaDataCard`（集合元数据） |
| `detail/Info/` | 配置 Tab | `index`（基础配置/模型切换触发重建/autoSync/API 服务）、`EditApiServiceModal` |
| `detail/CollectionCard/` | 集合列表 Tab | `index`（表格+6s 轮询训练态）、`Context`（`CollectionPageContext`）、`Header`（创建/导入菜单）、`TrainingStates`（进度弹窗 5s 轮询）、`TrainingErrorList`/`Modal`/`EditView`、`TagManageModal`/`TagsPopOver`/`HeaderTagPopOver`、`TemplateImportModal`/`BackupImportModal`、`WebsiteConfig`、`trainingStatesUtils` |
| `detail/Import/` | **数据导入向导** | `index`（按 source 分发）、`Context`（`DatasetImportContext`+`useMyStep`）、`diffSource/`（FileLocal/FileLink/FileCustomText/ExternalFile/APIDataset/ImageDataset/ReTraining 七源首步）、`commonProgress/`（DataProcess->PreviewData->Upload 共享后三步）、`components/`（FileSelector/FileSourceSelector/RenderFiles） |
| `detail/Test/` | **检索测试 Tab** | `index`、`hooks/useDatasetSearchTest`（调 postSearchText）、`hooks/useSearchTestImages`（多模态图片上传）、`components/`（TestInputPanel/TestResults/TestHistories/SearchTestImagePreviewList） |
| `detail/components/InputDataModal/` | 单条数据增改弹窗 | `index`、`useInputDataModal`（索引乐观更新+并发控制）、`DataInputPanel`、`IndexInputPanel` |
| `detail/data/` | 图片集合插入 | `InsertImageModal` |
| `detail/Form/` | 共享分块表单 | `CollectionChunkForm`（被 Import/DataProcess、WebsiteConfig、Info 复用） |

---

## 四、两条核心业务链路（端到端）

### 链路 A：数据导入与训练（写）

```
L5 Import/diffSource/* 选源 -> commonProgress/Upload
  └─ L4 api/collection.postCreateDataset*Collection (-> /collection/create/*)
       └─ L3 collection/create/*.ts (multer/S3 上传 + authDataset + parseApiInput)
            └─ L2 collection/controller.createCollectionAndInsertData
                 ├─ read.rawText2Chunks 切块
                 ├─ collection/utils.getTrainingModeByCollection 定模式(chunk/qa/auto/image/imageParse)
                 └─ training/controller.pushDataListToTrainingQueue -> 写 dataset_trainings
                      └─ [服务端 worker] queues/datasetParse -> generateQA -> generateVector
                           └─ data/data.createDatasetData + dataIndex.insertVectors
                                -> 写 dataset_datas + dataset_data_texts + 向量库 + S3
                                     └─ L4 context 轮询 getDatasetTrainingQueue 回显进度
```

### 链路 B：知识库检索（读）

```
L5 Test/hooks/useDatasetSearchTest -> L4 api.postSearchText (-> /dataset/searchTest)
  └─ L3 searchTest.ts (authDataset + 计费)
       └─ L2 search/index.defaultSearchDatasetData
            ├─ utils.datasetSearchQueryExtension (LLM 扩展 query)
            └─ defaultRecall/index.searchDatasetData (8 步):
                 1. imageCaption (VLM 图片->文本 query)
                 2. collectionFilter (forbid/标签过滤)
                 3. multiQueryRecall 并行: embeddingRecall(向量库) + fullTextRecall(Mongo $text)
                 4. result.concatRecallLists (RRF 融合)
                 5. rerank.reRankSearchResults (文本精排,失败降级)
                 6. removeDuplicateSearchResults / filterSearchResultsByScore
                 7. data/controller.formatDatasetDataValues (S3 预览 URL 签发)
                 8. 返回 SearchDataResponseItemType[]
```

> 工作流中的"知识库搜索"节点也复用 L2 的 `defaultSearchDatasetData`/`deepRagSearch`，不经 L3 页面路由。

---

## 五、二次开发提示

- **加新数据源**：L1 `apiDataset/type.ts` 加 schema -> L2 `apiDataset/` 加适配器（实现 5 方法）+ `index.ts` 注册 -> L3 `collection/create/` 加路由 -> L4 `api/collection.ts` 加封装 -> L5 `Import/diffSource/` 加首步组件。
- **加新训练模式**：L1 `TrainingModeEnum` 加值 -> L2 `getTrainingModeByCollection` 分流 + `pushDataListToTrainingQueue` 选模型 -> `queues/` 加消费者。
- **改检索策略**：L2 `search/defaultRecall/` 是流水线，`result.ts` 的 RRF 融合在 L1 `search/utils.ts`。
- **遵循规范**：L3 入参必须 `parseApiInput`；L2 写操作支持可选 `session` + `mongoSessionRun`；L2 schema/entity/service/utils 分层；L1 `core/` 禁引 mongoose。
- **命名陷阱**：`store/markdata.ts` 与 `store/searchTest.ts` 都导出 `useSearchTestStore`，是两个独立 store。
