/** 与 Rust `UPDATE_CHECK_TIMEOUT_MARKER` 一致 */
export const UPDATE_CHECK_TIMEOUT_MARKER = "UPDATE_CHECK_TIMEOUT";

export function isUpdateCheckTimeoutError(message: string): boolean {
  return message.includes(UPDATE_CHECK_TIMEOUT_MARKER);
}
