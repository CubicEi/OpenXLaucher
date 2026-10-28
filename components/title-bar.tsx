'use client'

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Copy, Cpu, Maximize2, Minus, X } from 'lucide-react'
import { usePathname, useRouter } from 'next/navigation'

import { useTheme } from 'next-themes'

import { ModeToggle } from '@/components/mode-toggle'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ThemeSlot } from '@/components/themes/theme-slot'
import { useThemeRuntime } from '@/components/themes/theme-runtime-provider'
import { useI18n } from '@/components/i18n/use-i18n'
import { PROCESS_LIST_BUTTON_ID } from '@/components/process-list/fly-to-process-list'
import {
  navigateWithMainTransition,
  normalizeAppPathname,
} from '@/lib/main-navigation-transition'

interface WindowApi {
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  unmaximize: () => Promise<void>
  close: () => Promise<void>
  isMaximized: () => Promise<boolean>
}

interface TitleBarProps {
  className?: string
}

interface WindowButtonProps {
  onClick: () => void
  title: string
  children: React.ReactNode
  className?: string
}

const TITLEBAR_ICON_LIGHT = '/icon/icon_black.svg'
const TITLEBAR_ICON_DARK = '/icon/icon_white.svg'

function AppLogo({ className }: { className?: string }) {
  const { resolvedTheme } = useTheme()
  const mounted = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false
  )
  const src =
    mounted && resolvedTheme === 'dark'
      ? TITLEBAR_ICON_DARK
      : TITLEBAR_ICON_LIGHT

  return (
    // eslint-disable-next-line @next/next/no-img-element -- theme-specific SVG assets
    <img
      src={src}
      alt=''
      width={20}
      height={20}
      className={cn('h-5 w-5 shrink-0 object-contain', className)}
      draggable={false}
    />
  )
}

function detectMacOS() {
  if (typeof window === 'undefined') {
    return false
  }

  const platform = window.navigator.userAgent.toLowerCase()
  return platform.includes('mac')
}

const subscribeToNothing = () => () => undefined
const serverIsMacOS = () => false

function WindowButton({ onClick, title, children, className }: WindowButtonProps) {
  return (
    <Button
      type='button'
      variant='ghost'
      size='icon'
      className={cn(
        'h-8 w-8 rounded-full border-0 transition-colors hover:bg-muted/80 active:bg-muted focus-visible:ring-0 focus-visible:ring-offset-0',
        className
      )}
      onClick={onClick}
      title={title}
    >
      {children}
    </Button>
  )
}

function ProcessListButton() {
  const router = useRouter()
  const pathname = usePathname()
  const { t } = useI18n()
  const label = t('processList.open')
  const isActive = normalizeAppPathname(pathname) === '/process-list'

  const handleClick = () => {
    if (isActive) return
    navigateWithMainTransition(router, '/process-list')
  }

  return (
    <Button
      id={PROCESS_LIST_BUTTON_ID}
      type='button'
      variant='ghost'
      size='icon'
      className={cn(
        'h-8 w-8 rounded-full',
        isActive && 'bg-muted text-foreground'
      )}
      onClick={handleClick}
      title={label}
      aria-label={label}
      aria-current={isActive ? 'page' : undefined}
    >
      <Cpu className='h-4 w-4' />
    </Button>
  )
}

export function TitleBar({ className }: TitleBarProps) {
  const { slots, snapshot, reportThemeError } = useThemeRuntime()
  const themeSlot = { registry: slots, owner: snapshot.activeOwner, onError: reportThemeError }
  const isMacOS = useSyncExternalStore(
    subscribeToNothing,
    detectMacOS,
    serverIsMacOS
  )
  const [isMaximized, setIsMaximized] = useState(false)
  const [windowApi, setWindowApi] = useState<WindowApi | null>(null)

  useEffect(() => {
    let unlisten: (() => void) | undefined

    const initWindow = async () => {
      try {
        if (typeof window === 'undefined') {
          return
        }

        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        const webviewWindow = getCurrentWebviewWindow()

        setWindowApi({
          minimize: () => webviewWindow.minimize(),
          maximize: () => webviewWindow.maximize(),
          unmaximize: () => webviewWindow.unmaximize(),
          close: () => webviewWindow.close(),
          isMaximized: () => webviewWindow.isMaximized(),
        })

        setIsMaximized(await webviewWindow.isMaximized())
        unlisten = await webviewWindow.onResized(() => {
          webviewWindow.isMaximized().then(setIsMaximized)
        })
      } catch (err) {
        console.log('Window API not available:', err)
      }
    }

    initWindow()

    return () => {
      if (unlisten) {
        unlisten()
      }
    }
  }, [])

  const handleMinimize = useCallback(async () => {
    if (!windowApi) {
      return
    }

    try {
      await windowApi.minimize()
    } catch (err) {
      console.error('Minimize failed:', err)
    }
  }, [windowApi])

  const handleMaximizeRestore = useCallback(async () => {
    if (!windowApi) {
      return
    }

    try {
      if (isMaximized) {
        await windowApi.unmaximize()
      } else {
        await windowApi.maximize()
      }
    } catch (err) {
      console.error('Maximize/Restore failed:', err)
    }
  }, [isMaximized, windowApi])

  const handleClose = useCallback(async () => {
    if (!windowApi) {
      return
    }

    try {
      await windowApi.close()
    } catch (err) {
      console.error('Close failed:', err)
    }
  }, [windowApi])

  return (
    <div
      className={cn(
        'relative h-10 border-b border-border bg-background/95 backdrop-blur select-none',
        className
      )}
    >
      {isMacOS ? (
        <>
          <div className='absolute inset-0' data-tauri-drag-region />

          <div className='no-drag absolute inset-y-0 left-0 flex items-center pl-3'>
            <ThemeSlot {...themeSlot} slotId='app.titlebar.leading' />
          </div>

          <div className='pointer-events-none absolute inset-y-0 left-0 right-0 flex items-center justify-center'>
            <ThemeSlot {...themeSlot} slotId='app.titlebar.center'>
              <div className='flex items-center gap-2' data-tauri-drag-region>
                <AppLogo />
                <span className='text-sm font-medium text-foreground/80'>OpenXLauncher</span>
              </div>
            </ThemeSlot>
          </div>

          <div className='no-drag absolute inset-y-0 right-0 flex items-center gap-1 pr-3'>
            <ThemeSlot {...themeSlot} slotId='app.titlebar.actions'>
              <div className='flex items-center gap-1'>
                <ProcessListButton />
                <ModeToggle />
              </div>
            </ThemeSlot>
          </div>
        </>
      ) : (
        <div className='flex h-full items-center' data-tauri-drag-region>
          <ThemeSlot {...themeSlot} slotId='app.titlebar.leading'>
            <div className='flex h-full items-center gap-2 px-3' data-tauri-drag-region>
              <AppLogo />
              <span className='text-sm font-medium text-foreground/80'>OpenXLauncher</span>
            </div>
          </ThemeSlot>

          <div className='flex h-full flex-1 items-center justify-center' data-tauri-drag-region>
            <ThemeSlot {...themeSlot} slotId='app.titlebar.center' />
          </div>

          <div className='no-drag flex h-full items-center gap-1'>
            <ThemeSlot {...themeSlot} slotId='app.titlebar.actions'>
              <div className='flex items-center gap-1'>
                <ProcessListButton />
                <ModeToggle />
              </div>
            </ThemeSlot>

            <div className='flex items-center gap-1 pr-3'>
              <WindowButton onClick={handleMinimize} title='最小化'>
                <Minus className='size-4' />
              </WindowButton>

              <WindowButton onClick={handleMaximizeRestore} title={isMaximized ? '还原' : '最大化'}>
                {isMaximized ? <Copy className='size-3.5 rotate-90' /> : <Maximize2 className='size-3.5' />}
              </WindowButton>

              <WindowButton
                onClick={handleClose}
                title='关闭'
                className='hover:bg-destructive hover:text-white active:bg-destructive/90 dark:hover:bg-red-600 dark:active:bg-red-700'
              >
                <X className='size-4' />
              </WindowButton>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
