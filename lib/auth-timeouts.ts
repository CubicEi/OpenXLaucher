/**
 * 启动路径微软认证前端预算。
 * 须不短于 Rust `build_auth_http_client`（timeout 45s / connect 20s）
 * 加上多跳刷新与暂态重试的总耗时。
 */
export const MS_LAUNCH_SILENT_REFRESH_BUDGET_MS = 90_000;
export const MS_LAUNCH_DEVICE_CODE_BUDGET_MS = 45_000;
