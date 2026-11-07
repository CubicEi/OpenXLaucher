"use client";

/**
 * 兼容旧导入路径：实现已提升到顶层 `components/global/corner-notice.tsx`。
 */
export {
  CornerNoticeProvider,
  useCornerNotice,
  type CornerNoticeItem,
  type CornerNoticeVariant,
  type PushCornerNoticeInput,
} from "@/components/global/corner-notice";

export {
  CornerNoticeProvider as DownloadCornerNoticeProvider,
  useCornerNotice as useDownloadCornerNotice,
  type CornerNoticeItem as DownloadCornerNoticeItem,
  type CornerNoticeVariant as DownloadCornerNoticeVariant,
  type PushCornerNoticeInput as PushDownloadCornerNoticeInput,
} from "@/components/global/corner-notice";
