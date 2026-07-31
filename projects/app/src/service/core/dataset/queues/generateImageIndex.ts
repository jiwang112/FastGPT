// 文件用途：VLM 图片索引消费者，消费 mode=image / mode=imageParse 训练任务。
// 调用 VLM 识别图片生成文本描述，挂回 trainingData 后转入 mode=chunk 队列，
// 由 generateVector 完成文本向量化与 imageEmbedding 补齐。

import { MongoDatasetTraining } from '@fastgpt/service/core/dataset/training/schema';
import { pushLLMTrainingUsage } from '@fastgpt/service/support/wallet/usage/controller';
import { TrainingModeEnum } from '@fastgpt/global/core/dataset/constants';
import { checkTeamAiPointsAndLock } from './utils';
import { addMinutes } from 'date-fns';
import { getLogger, LogCategories } from '@fastgpt/service/common/logger';
import { getErrText } from '@fastgpt/global/common/error/utils';
import { delay } from '@fastgpt/service/common/bullmq';
import { createLLMResponse } from '@fastgpt/service/core/ai/llm/request';
import { UsageItemTypeEnum } from '@fastgpt/global/support/wallet/usage/constants';
import { mongoSessionRun } from '@fastgpt/service/common/mongo/sessionRun';
import { getVlmModel, getEmbeddingModel } from '@fastgpt/service/core/ai/model';
import { getMaxIndexSize } from '@fastgpt/global/core/dataset/training/utils';
import { DatasetDataIndexTypeEnum } from '@fastgpt/global/core/dataset/data/constants';
import { getDatasetImageIndexCapability } from '@fastgpt/service/core/dataset/utils';
import { uniqueDatasetDataMarkdownImageUrls } from '@fastgpt/service/core/dataset/data/utils';
import { normalizeDatasetIndexImageToModelInput } from '@/service/core/dataset/data/dataIndex';
import type { DatasetTrainingSchemaType } from '@fastgpt/global/core/dataset/type';

const logger = getLogger(LogCategories.MODULE.DATASET.IMAGE_INDEX);

// VLM 图片描述 prompt：训练场景下生成简洁中文描述，供 default 文本索引检索
const VLM_IMAGE_DESCRIBE_PROMPT =
  '请详细描述这张图片的内容，包括主体、场景、颜色、可见文字和关键视觉特征。输出一段简洁的中文描述，不要解释。';

const reduceQueue = () => {
  global.imageQueueLen = global.imageQueueLen > 0 ? global.imageQueueLen - 1 : 0;

  return global.imageQueueLen === 0;
};

type PopulateType = {
  dataset: { vectorModel: string; vlmModel?: string };
  collection: { name: string; indexPrefixTitle: boolean; imageIndex?: boolean };
};
type TrainingDataType = DatasetTrainingSchemaType & PopulateType;

// 消费者处理结果：组装转 chunk 任务所需字段
type ImageHandleResult = {
  q: string;
  indexes?: DatasetTrainingSchemaType['indexes'];
  imageId?: string;
  imageDescMap?: Record<string, string>;
  dataId?: string;
  inputTokens: number;
  outputTokens: number;
};

/**
 * 调用 VLM 识别单张图片生成文本描述。
 *
 * 入参 imageUrl 可以是 S3 object key（dataset/temp/chat）或 http(s) URL，
 * 由 normalizeDatasetIndexImageToModelInput 统一归一化为 base64。
 * 失败时返回空描述与 0 token，由调用方决定降级策略（跳过该图或抛错重试）。
 */
const describeImageByVlm = async ({
  teamId,
  vlmModel,
  imageUrl
}: {
  teamId: string;
  vlmModel: string;
  imageUrl: string;
}): Promise<{ desc: string; inputTokens: number; outputTokens: number }> => {
  try {
    const vlmModelData = getVlmModel(vlmModel);
    // 防御性校验 vision（调用方已校验，但 getVlmModel 可能回退到首个 VLM 模型）
    if (!vlmModelData?.vision) {
      return { desc: '', inputTokens: 0, outputTokens: 0 };
    }

    // 图片源归一化：S3 key -> base64，http(s) URL -> base64
    const base64Url = await normalizeDatasetIndexImageToModelInput(imageUrl);

    const {
      answerText,
      usage: { inputTokens, outputTokens }
    } = await createLLMResponse({
      teamId,
      saveLLMResponseRecord: false,
      body: {
        model: vlmModelData.model,
        stream: true,
        useVision: true,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: { url: base64Url }
              },
              {
                type: 'text',
                text: VLM_IMAGE_DESCRIBE_PROMPT
              }
            ]
          }
        ] as any
      }
    });

    return {
      desc: answerText.trim(),
      inputTokens,
      outputTokens
    };
  } catch (error) {
    // 单张图 VLM 失败：warn 日志 + 返回空，由调用方决定是否跳过
    logger.warn('VLM describe image failed', { teamId, imageUrl, error });
    return { desc: '', inputTokens: 0, outputTokens: 0 };
  }
};

/**
 * 处理 mode=imageParse 任务：纯图数据，VLM 描述作为 q。
 *
 * imageParse 必有 VLM 与 imageId（入队时保证），这里防御性校验。
 * VLM 描述写入 q 供 default 文本索引检索，同时保留 imageId 供 imageEmbedding 图片向量索引，
 * 实现"文本描述 + 图片向量"双路命中。无 dataId，转 chunk 走 insertData 新建数据。
 */
const handleImageParse = async (trainingData: TrainingDataType): Promise<ImageHandleResult> => {
  const { availableVlmModel, supportVlm } = getDatasetImageIndexCapability({
    vectorModel: trainingData.dataset.vectorModel,
    vlmModel: trainingData.dataset.vlmModel
  });

  // imageParse 必有 VLM（入队时保证），防御性校验
  if (!supportVlm || !availableVlmModel || !trainingData.imageId) {
    throw new Error('ImageParse task missing VLM or imageId');
  }

  const { desc, inputTokens, outputTokens } = await describeImageByVlm({
    teamId: trainingData.teamId,
    vlmModel: availableVlmModel.model,
    imageUrl: trainingData.imageId
  });

  // VLM 失败（描述为空）：抛错走 errorMsg 重试
  if (!desc) {
    throw new Error('VLM describe image failed for imageParse');
  }

  return {
    q: desc,
    imageId: trainingData.imageId,
    imageDescMap: { [trainingData.imageId]: desc },
    inputTokens,
    outputTokens
  };
};

/**
 * 处理 mode=image 任务：文档 markdown 图片，VLM 描述作为 type:image 索引。
 *
 * - 无 VLM 降级：直接转 chunk（保留原 q/indexes/dataId），由 generateVector 仅生成 imageEmbedding。
 * - 有 VLM：提取 q 中 markdown 图片 URL，并行调用 VLM 生成描述，追加为 image 索引。
 *   单张失败跳过，全部失败抛错重试。带 dataId，转 chunk 走 rebuildData 重建。
 */
const handleImage = async (trainingData: TrainingDataType): Promise<ImageHandleResult> => {
  const { availableVlmModel, supportVlm } = getDatasetImageIndexCapability({
    vectorModel: trainingData.dataset.vectorModel,
    vlmModel: trainingData.dataset.vlmModel
  });

  const baseIndexes = trainingData.indexes ?? [];

  // 无 VLM 降级：直接转 chunk，跳过 VLM，由 generateVector 生成 imageEmbedding
  if (!supportVlm || !availableVlmModel) {
    return {
      q: trainingData.q,
      indexes: baseIndexes,
      dataId: trainingData.dataId,
      inputTokens: 0,
      outputTokens: 0
    };
  }

  // 提取 q 中的 markdown 图片 URL（去重，按首次出现顺序）
  const urls = uniqueDatasetDataMarkdownImageUrls([trainingData.q]);

  // 无图片：直接转 chunk（保留原 q/indexes）
  if (urls.length === 0) {
    return {
      q: trainingData.q,
      indexes: baseIndexes,
      dataId: trainingData.dataId,
      inputTokens: 0,
      outputTokens: 0
    };
  }

  // 并行调用 VLM 识别每张图片
  const results = await Promise.all(
    urls.map((url) =>
      describeImageByVlm({
        teamId: trainingData.teamId,
        vlmModel: availableVlmModel.model,
        imageUrl: url
      }).then((res) => ({ url, ...res }))
    )
  );

  const validResults = results.filter((item) => item.desc);

  // 全部失败：抛错走 errorMsg 重试
  if (validResults.length === 0) {
    throw new Error('VLM describe all images failed');
  }

  // 追加 image 索引：VLM 描述作为独立文本索引，与 default（文本）、imageEmbedding（图片向量）三路并存
  const imageIndexes = validResults.map((item) => ({
    type: DatasetDataIndexTypeEnum.image,
    text: item.desc
  }));
  const imageDescMap: Record<string, string> = {};
  validResults.forEach((item) => {
    imageDescMap[item.url] = item.desc;
  });

  return {
    q: trainingData.q,
    indexes: [...baseIndexes, ...imageIndexes],
    imageDescMap,
    dataId: trainingData.dataId,
    inputTokens: results.reduce((sum, item) => sum + item.inputTokens, 0),
    outputTokens: results.reduce((sum, item) => sum + item.outputTokens, 0)
  };
};

/**
 * VLM 图片索引消费者主体。
 *
 * 消费 mode=image / mode=imageParse 训练任务：
 * 1. findOneAndUpdate 抢锁（mode $in，lockTime <= -10min，retryCount > 0）。
 * 2. populate dataset(vectorModel/vlmModel) + collection(name/indexPrefixTitle/imageIndex)。
 * 3. checkTeamAiPointsAndLock 校验团队 AI 点数。
 * 4. 按 mode 分发 handleImageParse / handleImage，调用 VLM 生成描述并组装转 chunk 字段。
 * 5. mongoSessionRun 内直接 MongoDatasetTraining.create chunk 任务 + deleteOne 当前任务
 *    （pushDataListToTrainingQueue 不透传 imageDescMap，故直接 create）。
 * 6. pushLLMTrainingUsage 计 VLM 调用 token（文本/image embedding 由 generateVector 计费）。
 * 7. catch 写 errorMsg + delay(100)，不删任务（等重试或人工处理）。
 *
 * 并发闸门：global.imageQueueLen，上限 global.systemEnv.vlmMaxProcess || 5（VLM 慢且占资源）。
 */
export async function generateImageIndex(): Promise<any> {
  const max = global.systemEnv?.vlmMaxProcess || 5;
  logger.debug('Image index queue size check', { queueSize: global.imageQueueLen, max });

  if (global.imageQueueLen >= max) return;
  global.imageQueueLen++;

  try {
    while (true) {
      const startTime = Date.now();

      // get training data
      const {
        data,
        done = false,
        error = false
      } = await (async () => {
        try {
          const data = await MongoDatasetTraining.findOneAndUpdate(
            {
              mode: { $in: [TrainingModeEnum.image, TrainingModeEnum.imageParse] },
              retryCount: { $gt: 0 },
              lockTime: { $lte: addMinutes(new Date(), -10) }
            },
            {
              lockTime: new Date(),
              $inc: { retryCount: -1 }
            }
          )
            .populate<PopulateType>([
              {
                path: 'dataset',
                select: 'vectorModel vlmModel'
              },
              {
                path: 'collection',
                select: 'name indexPrefixTitle imageIndex'
              }
            ])
            .lean();

          // task preemption
          if (!data) {
            return { done: true };
          }
          return { data };
        } catch {
          return { error: true };
        }
      })();

      if (done || !data) {
        break;
      }
      if (error) {
        logger.error('Image index queue fetch task failed', { error });
        await delay(500);
        continue;
      }

      if (!data.dataset || !data.collection) {
        logger.info('Image index queue task skipped: dataset or collection missing', {
          datasetId: data.datasetId,
          collectionId: data.collectionId,
          trainingId: data._id
        });
        // Delete data
        await MongoDatasetTraining.deleteOne({ _id: data._id });
        continue;
      }

      // auth balance
      if (!(await checkTeamAiPointsAndLock(data.teamId, String(data._id)))) {
        continue;
      }

      logger.info('Image index queue task started', {
        trainingId: data._id,
        datasetId: data.datasetId,
        collectionId: data.collectionId,
        teamId: data.teamId,
        tmbId: data.tmbId,
        mode: data.mode
      });

      try {
        const isImageParse = data.mode === TrainingModeEnum.imageParse;

        // 调用 VLM 生成图片描述，组装转 chunk 任务所需字段
        const { q, indexes, imageId, imageDescMap, dataId, inputTokens, outputTokens } =
          isImageParse ? await handleImageParse(data) : await handleImage(data);

        const embModel = getEmbeddingModel(data.dataset.vectorModel);

        // 直接 create chunk 任务（pushDataListToTrainingQueue 不透传 imageDescMap）
        await mongoSessionRun(async (session) => {
          await MongoDatasetTraining.create(
            [
              {
                teamId: data.teamId,
                tmbId: data.tmbId,
                datasetId: data.datasetId,
                collectionId: data.collectionId,
                billId: data.billId,
                mode: TrainingModeEnum.chunk,
                q,
                ...(data.a && { a: data.a }),
                ...(imageId && { imageId }),
                chunkIndex: data.chunkIndex ?? 0,
                indexSize: data.indexSize || getMaxIndexSize(embModel),
                ...(indexes && { indexes }),
                ...(imageDescMap && { imageDescMap }),
                ...(dataId && { dataId }),
                retryCount: 5
              }
            ],
            { session, ordered: true }
          );
          // delete current image/imageParse task
          await MongoDatasetTraining.deleteOne({ _id: data._id }, { session });
        });

        // 计费：仅 VLM 调用计 token；文本/image embedding 由 generateVector 的 pushGenerateVectorUsage 统一计
        if (inputTokens + outputTokens > 0) {
          const { availableVlmModel } = getDatasetImageIndexCapability({
            vectorModel: data.dataset.vectorModel,
            vlmModel: data.dataset.vlmModel
          });
          pushLLMTrainingUsage({
            teamId: data.teamId,
            inputTokens,
            outputTokens,
            usageId: data.billId,
            model: availableVlmModel?.model ?? '',
            type: isImageParse
              ? UsageItemTypeEnum.training_imageParse
              : UsageItemTypeEnum.training_imageIndex
          });
        }

        logger.info('Image index queue task finished', {
          durationMs: Date.now() - startTime,
          usage: { inputTokens, outputTokens },
          trainingId: data._id,
          datasetId: data.datasetId,
          collectionId: data.collectionId
        });
      } catch (err: any) {
        logger.error('Image index queue task failed', {
          error: err,
          trainingId: data._id,
          datasetId: data.datasetId,
          collectionId: data.collectionId
        });
        await MongoDatasetTraining.updateOne(
          {
            _id: data._id
          },
          {
            errorMsg: getErrText(err, 'unknown error')
          }
        );
        await delay(100);
      }
    }
  } catch (error) {
    logger.error('Image index queue loop failed', { error });
  }

  if (reduceQueue()) {
    logger.info('Image index queue drained', { queueSize: global.imageQueueLen });
  }
  logger.debug('Image index queue loop exit', { queueSize: global.imageQueueLen });
}
