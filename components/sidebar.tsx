"use client"

import {
  Home,
  Download,
  Rocket,
  Wrench,
  Settings,
  Gamepad2,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { motion } from "framer-motion"
import { cn } from "@/lib/utils"
import { buttonVariants } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { useUIConfigContext } from "@/components/ui-config/ui-config-provider"
import { useI18n, type TranslationKey } from "@/components/i18n/use-i18n"
import { ThemeSlot } from "@/components/themes/theme-slot"
import { useThemeRuntime } from "@/components/themes/theme-runtime-provider"
import { SidebarLaunchButton } from "@/components/launch/sidebar-launch-button"
import {
  navigateWithMainTransition,
  normalizeAppPathname,
} from "@/lib/main-navigation-transition"

interface SidebarProps {
  className?: string
}

interface NavItem {
  id: string
  icon: React.ReactNode
  label: string
  href: string
  isAvatar?: boolean
}

const NAV_ITEM_BASE: Omit<NavItem, "label">[] = [
  { id: "home", icon: <Home className="size-4" />, href: "/" },
  { id: "game-settings", icon: <Gamepad2 className="size-4" />, href: "/game-settings" },
  { id: "launch", icon: <Rocket className="size-4" />, href: "/launch" },
  { id: "download", icon: <Download className="size-4" />, href: "/download" },
  { id: "tools", icon: <Wrench className="size-4" />, href: "/tools" },
  { id: "settings", icon: <Settings className="size-4" />, href: "/settings" },
]

const NAV_LABELS: Record<string, TranslationKey> = {
  home: "sidebar.home",
  "game-settings": "sidebar.gameSettings",
  launch: "sidebar.launch",
  download: "sidebar.downloads",
  tools: "sidebar.tools",
  settings: "sidebar.settings",
}

function NavButton({ item, isActive, isExactActive }: { item: NavItem; isActive: boolean; isExactActive: boolean }) {
  const router = useRouter()

  const handleNavigation = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return
    }

    if (isExactActive) {
      event.preventDefault()
      return
    }

    event.preventDefault()
    navigateWithMainTransition(router, item.href)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href={item.href}
          onClick={handleNavigation}
          suppressHydrationWarning
          aria-label={item.label}
          aria-current={isActive ? "page" : undefined}
          className={cn(
            item.isAvatar
              ? "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              : buttonVariants({ variant: "ghost", size: "icon" }),
            "relative overflow-hidden touch-manipulation",
            !item.isAvatar && isActive && "text-accent-foreground"
          )}
        >
          {item.isAvatar ? (
            <span
              className={cn(
                "flex size-9 items-center justify-center rounded-4xl transition-colors duration-200",
                isActive && "ring-2 ring-primary ring-offset-2 ring-offset-sidebar"
              )}
            >
              {item.icon}
            </span>
          ) : (
            <>
              {isActive && (
                <motion.span
                  layoutId="active-nav-indicator"
                  className="absolute inset-0 rounded-md bg-accent"
                  transition={{ type: "spring", stiffness: 380, damping: 30 }}
                />
              )}
              <span className="relative z-10">{item.icon}</span>
            </>
          )}
        </Link>
      </TooltipTrigger>
      <TooltipContent side="right">
        <p>{item.label}</p>
      </TooltipContent>
    </Tooltip>
  )
}

function isNavItemActive(pathname: string, href: string) {
  const current = normalizeAppPathname(pathname)
  const target = normalizeAppPathname(href)
  if (target === "/") return current === "/"
  return current === target || current.startsWith(`${target}/`)
}

function isNavItemExactActive(pathname: string, href: string) {
  return normalizeAppPathname(pathname) === normalizeAppPathname(href)
}

export function Sidebar({ className }: SidebarProps) {
  const pathname = usePathname()
  const { config, configLoaded } = useUIConfigContext()
  const { t } = useI18n()
  const { slots, snapshot, reportThemeError } = useThemeRuntime()
  const allNavItems = NAV_ITEM_BASE.map((item) => ({
    ...item,
    label: NAV_LABELS[item.id] ? t(NAV_LABELS[item.id]) : item.id,
  }))

  const isActive = (href: string) => isNavItemActive(pathname, href)
  const isExactActive = (href: string) => isNavItemExactActive(pathname, href)

  // 根据配置过滤可见的导航项
  const visibleNavItems = configLoaded
    ? allNavItems.filter(item => {
        const tabConfig = config.sidebarTabs.find(tab => tab.id === item.id);
        return tabConfig ? tabConfig.visible : true;
      })
    : allNavItems;

  // 分离顶部和底部导航项
  const topNavItems = visibleNavItems.filter(item => item.id !== "settings");
  const bottomNavItems = visibleNavItems.filter(item => item.id === "settings");

  const builtInSidebar = (
    <aside
      data-app-sidebar
      className={cn(
        "flex h-full w-14 flex-col border-r border-border bg-sidebar",
        className
      )}
    >
      <ThemeSlot registry={slots} owner={snapshot.activeOwner} slotId="app.sidebar.header" onError={reportThemeError} />
      <ThemeSlot registry={slots} owner={snapshot.activeOwner} slotId="app.sidebar.navigation" onError={reportThemeError}>
        <nav className="flex flex-1 flex-col items-center gap-2 p-2">
          {topNavItems.map((item) => (
            <NavButton key={item.href} item={item} isActive={isActive(item.href)} isExactActive={isExactActive(item.href)} />
          ))}
        </nav>
      </ThemeSlot>

      <ThemeSlot registry={slots} owner={snapshot.activeOwner} slotId="app.sidebar.footer" onError={reportThemeError}>
        <div className="flex flex-col items-center gap-2 border-t border-border p-2">
          <SidebarLaunchButton />
          {bottomNavItems.map((item) => (
            <NavButton key={item.href} item={item} isActive={isActive(item.href)} isExactActive={isExactActive(item.href)} />
          ))}
        </div>
      </ThemeSlot>
    </aside>
  )

  return (
    <ThemeSlot registry={slots} owner={snapshot.activeOwner} slotId="app.sidebar" onError={reportThemeError}>
      {builtInSidebar}
    </ThemeSlot>
  )
}
