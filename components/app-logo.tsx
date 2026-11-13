"use client";

import { cn } from "@/lib/utils";

const APP_LOGO_LIGHT = "/icon/icon_black.svg";
const APP_LOGO_DARK = "/icon/icon_white.svg";

/** 标题栏 / 弹窗用启动器徽标（随 `.dark` 切换浅色、深色资源） */
export function AppLogo({ className }: { className?: string }) {
  const imgClass = cn("h-5 w-5 shrink-0 object-contain", className);
  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- theme-specific SVG assets */}
      <img
        src={APP_LOGO_LIGHT}
        alt=""
        width={20}
        height={20}
        className={cn(imgClass, "dark:hidden")}
        draggable={false}
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- theme-specific SVG assets */}
      <img
        src={APP_LOGO_DARK}
        alt=""
        width={20}
        height={20}
        className={cn(imgClass, "hidden dark:block")}
        draggable={false}
      />
    </>
  );
}
