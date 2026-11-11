/** 愚人节版本 ID 特征（大小写不敏感子串匹配） */
export const APRIL_FOOLS_ID_INDICATORS = [
  "20w14infinite",
  "15w14a",
  "2.0",
  "1.RV-Pre1",
  "3D Shareware v1.34",
] as const;

/** 形如 1.20.1 / 26.1.1 的正式版号，不应因 4 月 1 日发售日被归入愚人节 */
const PLAIN_RELEASE_ID = /^\d+\.\d+(\.\d+)?$/;

export function isPlainReleaseVersionId(versionId: string): boolean {
  return PLAIN_RELEASE_ID.test(versionId);
}

export function isAprilFoolsVersion(
  versionId: string,
  releaseTime: string,
  manifestType?: string,
): boolean {
  const idLower = versionId.toLowerCase();
  if (
    APRIL_FOOLS_ID_INDICATORS.some((indicator) =>
      idLower.includes(indicator.toLowerCase()),
    )
  ) {
    return true;
  }
  if (
    manifestType === "release" ||
    isPlainReleaseVersionId(versionId)
  ) {
    return false;
  }
  return releaseTime.includes("-04-01");
}
