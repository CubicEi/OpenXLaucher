/** 启动流程进行中（准备参数 / 等待正版登录 / 等待 game-process-started），供导航层避免整页 reload。 */

let launchInFlight = false;

export function setLaunchInFlight(active: boolean) {
  launchInFlight = active;
}

export function getLaunchInFlight() {
  return launchInFlight;
}
