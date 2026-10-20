"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** 联机 / OpenP2P 入口已移除，旧链接重定向到首页。 */
export default function MultiplayerPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/");
  }, [router]);

  return null;
}
