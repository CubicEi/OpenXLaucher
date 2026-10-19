/**
 * 使用浏览器原生 FileReader 将 Blob 编码为 base64 负载。
 *
 * 不通过 `String.fromCharCode(...bytes)` 展开整个 Uint8Array：较大的资源包、
 * 截图或世界文件会超过 JavaScript 的参数数量上限，并造成明显的主线程卡顿。
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onerror = () => {
      reject(reader.error ?? new Error("读取文件失败"));
    };

    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("文件编码失败"));
        return;
      }

      const commaIndex = reader.result.indexOf(",");
      resolve(commaIndex >= 0 ? reader.result.slice(commaIndex + 1) : reader.result);
    };

    reader.readAsDataURL(blob);
  });
}
