import { Check, Copy } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button, type ButtonProps } from '@/components/ui/button';

export function CopyButton({
  value,
  label = '复制',
  size = 'sm',
  variant = 'secondary',
  ...props
}: { value: string; label?: string } & Omit<ButtonProps, 'onClick' | 'children'>) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size={size}
      variant={variant}
      aria-live="polite"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success('已复制到剪贴板');
        } catch {
          toast.error('复制失败，请手动选择文本复制');
        }
      }}
      {...props}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {copied ? '已复制' : label}
    </Button>
  );
}
