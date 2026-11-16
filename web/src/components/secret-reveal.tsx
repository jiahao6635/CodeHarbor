import { Eye, EyeSlash, LockKey } from '@phosphor-icons/react';
import { useEffect, useId, useState } from 'react';
import { CopyButton } from '@/components/copy-button';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

export interface SecretItem {
  label: string;
  value: string;
  /** Shown beneath the value, e.g. the full webhook URL to configure. */
  hint?: string;
}

/**
 * Shows values that the server returns exactly once. The dialog cannot be dismissed by Escape or overlay
 * click; the operator must confirm they have saved the values. Nothing is persisted.
 */
export function SecretReveal({
  open,
  title,
  description,
  items,
  onClose,
  confirmLabel = '我已妥善保存，关闭',
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  items: SecretItem[];
  onClose: () => void;
  confirmLabel?: string;
  children?: React.ReactNode;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [visible, setVisible] = useState(false);
  const checkboxId = useId();
  useEffect(() => {
    if (!open) {
      setAcknowledged(false);
      setVisible(false);
    }
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={() => undefined}>
      <DialogContent
        size="lg"
        hideClose
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LockKey aria-hidden="true" className="size-5 text-accent" />
            {title}
          </DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Alert tone="warning" title="仅显示一次">
          关闭后服务端不会再次返回这些值。请复制并保存到团队的密码管理工具，不要粘贴到聊天、工单或截图中。
        </Alert>
        <div className="flex flex-col gap-4">
          {items.map((item) => (
            <div key={item.label} className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{item.label}</span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setVisible((current) => !current)}
                    aria-pressed={visible}
                    aria-label={visible ? '隐藏' : '显示'}
                  >
                    {visible ? <EyeSlash aria-hidden="true" /> : <Eye aria-hidden="true" />}
                    {visible ? '隐藏' : '显示'}
                  </Button>
                  <CopyButton value={item.value} />
                </div>
              </div>
              <output
                className="block select-all break-all rounded-sm border border-border bg-background px-3 py-2 font-mono text-sm"
                aria-label={item.label}
              >
                {visible ? item.value : '•'.repeat(Math.min(item.value.length, 48))}
              </output>
              {item.hint ? <p className="text-xs text-muted-foreground">{item.hint}</p> : null}
            </div>
          ))}
        </div>
        {children}
        <div className="flex items-center gap-2">
          <Checkbox
            id={checkboxId}
            checked={acknowledged}
            onCheckedChange={(value) => setAcknowledged(value === true)}
          />
          <Label htmlFor={checkboxId} className="font-normal">
            我已妥善保存上述内容
          </Label>
        </div>
        <DialogFooter>
          <Button disabled={!acknowledged} onClick={onClose}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
