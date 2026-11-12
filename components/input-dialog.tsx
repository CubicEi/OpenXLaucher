"use client";

import type { ReactNode } from "react";

import { DialogShell } from "@/components/dialog-shell";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";

export type InputDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** 标题栏下方说明（可含额外控件） */
  children?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  inputId?: string;
  placeholder?: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  confirming?: boolean;
  confirmDisabled?: boolean;
  onInputKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  className?: string;
  inputClassName?: string;
};

export function InputDialog({
  open,
  onOpenChange,
  title,
  children,
  value,
  onValueChange,
  inputId = "input-dialog-field",
  placeholder,
  confirmLabel,
  cancelLabel,
  onConfirm,
  confirming = false,
  confirmDisabled = false,
  onInputKeyDown,
  className,
  inputClassName,
}: InputDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent hideClose className={cn("!max-w-lg p-0 overflow-hidden", className)}>
        <DialogShell
          title={title}
          bodyClassName="space-y-3"
          footer={
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={confirming}
                onClick={() => onOpenChange(false)}
              >
                {cancelLabel}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={confirming || confirmDisabled}
                onClick={onConfirm}
              >
                {confirming ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : null}
                {confirmLabel}
              </Button>
            </>
          }
        >
          {children}
          <Input
            id={inputId}
            value={value}
            placeholder={placeholder}
            disabled={confirming}
            onChange={(e) => onValueChange(e.target.value)}
            onKeyDown={onInputKeyDown}
            className={inputClassName}
          />
        </DialogShell>
      </DialogContent>
    </Dialog>
  );
}
