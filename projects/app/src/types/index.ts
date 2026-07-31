import type { TrackEventName } from '@/web/common/system/constants';

declare global {
  var qaQueueLen: number;
  var vectorQueueLen: number;
  var datasetParseQueueLen: number;
  // VLM 图片索引消费者并发计数
  var imageQueueLen: number;

  interface Window {
    grecaptcha: any;
    QRCode: any;
    umami?: {
      track: (event: TrackEventName, data: any) => void;
    };
  }
}
