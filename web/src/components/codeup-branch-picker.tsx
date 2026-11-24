import { CaretDown, Check, GitBranch } from '@phosphor-icons/react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Popover } from 'radix-ui';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { apiFetch } from '@/api/client';
import { ErrorNotice } from '@/components/error-notice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { describedBy, Field } from '@/components/ui/label';
import { cn } from '@/lib/cn';

interface BranchPage {
  branches: { name: string; is_default: boolean }[];
  default_branch: string | null;
  next_page: number | null;
}

function useSettledValue(value: string, delay: number) {
  const [settled, setSettled] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

export function CodeupBranchPicker({
  repoId,
  value,
  onSelect,
  error,
}: {
  repoId: string;
  value: string;
  onSelect: (name: string) => void;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlight, setHighlight] = useState(0);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const defaultApplied = useRef(false);
  const settledRepo = useSettledValue(repoId, 250);
  const settledSearch = useSettledValue(search.trim(), 250);
  const ready = repoId !== '' && settledRepo === repoId;
  const query = useInfiniteQuery({
    queryKey: ['codeup-branches', repoId, settledSearch],
    enabled: ready,
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ page: String(pageParam) });
      if (settledSearch) params.set('search', settledSearch);
      return apiFetch<BranchPage>(`/api/v1/codeup/repositories/${encodeURIComponent(repoId)}/branches?${params}`, {
        signal,
      });
    },
    getNextPageParam: (last) => last.next_page ?? undefined,
    staleTime: 15_000,
    retry: false,
  });
  const searching = search.trim() !== settledSearch;
  const first = query.data?.pages[0];
  const defaultBranch = first?.default_branch;
  const branches = searching
    ? []
    : [
        ...new Set([
          ...(!settledSearch && first?.branches.length && defaultBranch ? [defaultBranch] : []),
          ...(query.data?.pages.flatMap((page) => page.branches.map((branch) => branch.name)) ?? []),
        ]),
      ];
  const highlighted = Math.min(highlight, branches.length - 1);

  useEffect(() => {
    if (!ready || settledSearch || !first || defaultApplied.current) return;
    defaultApplied.current = true;
    if (first.branches.length && defaultBranch && !value) onSelect(defaultBranch);
  }, [defaultBranch, first, onSelect, ready, settledSearch, value]);

  function select(name: string) {
    onSelect(name);
    setOpen(false);
    setSearch('');
  }

  function navigate(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      const name = branches[highlighted];
      if (name) select(name);
      return;
    }
    if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || branches.length === 0) return;
    event.preventDefault();
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const next = Math.min(branches.length - 1, Math.max(0, highlighted + direction));
    setHighlight(next);
    document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: 'nearest' });
  }

  const helper = !repoId ? '先选择一个云效仓库。' : '索引会跟踪所选分支。';
  const initialError = query.isError && !query.data;
  return (
    <Field id={id} label="分支" helper={helper} error={error}>
      <Popover.Root
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          setHighlight(0);
          if (!next) setSearch('');
        }}
      >
        <Popover.Trigger asChild>
          <Button
            id={id}
            type="button"
            variant="secondary"
            disabled={!repoId}
            className="w-full justify-between"
            aria-label={value ? `分支 ${value}` : '分支'}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy(id, { helper: true, error: Boolean(error) })}
          >
            <span className="flex min-w-0 items-center gap-2">
              <GitBranch aria-hidden="true" />
              <span className="truncate">{value || (repoId && query.isPending ? '正在加载分支…' : '选择分支')}</span>
            </span>
            <CaretDown aria-hidden="true" />
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            aria-label="选择云效分支"
            align="start"
            sideOffset={6}
            collisionPadding={12}
            className="z-50 w-[var(--radix-popover-trigger-width)] space-y-2 rounded-md border border-border bg-background p-2 shadow-lg"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              input.current?.focus();
            }}
          >
            <Input
              ref={input}
              role="combobox"
              aria-label="搜索分支"
              aria-autocomplete="list"
              aria-expanded="true"
              aria-controls={`${id}-options`}
              aria-activedescendant={highlighted < 0 ? undefined : `${id}-option-${highlighted}`}
              value={search}
              maxLength={255}
              onChange={(event) => {
                setSearch(event.target.value);
                setHighlight(0);
              }}
              onKeyDown={navigate}
              placeholder="搜索分支…"
            />
            {query.isPending || searching ? (
              <p role="status" className="px-2 py-1 text-sm text-muted-foreground">
                正在加载分支…
              </p>
            ) : null}
            {initialError ? (
              <>
                <ErrorNotice error={query.error} title="分支加载失败" />
                <Button size="sm" variant="secondary" type="button" onClick={() => void query.refetch()}>
                  重试
                </Button>
              </>
            ) : null}
            {ready && !searching && query.isSuccess && branches.length === 0 ? (
              <p role="status" className="px-2 py-1 text-sm text-muted-foreground">
                {settledSearch ? '没有匹配的分支' : '这个仓库暂无分支'}
              </p>
            ) : null}
            <div id={`${id}-options`} role="listbox" aria-label="云效分支" className="max-h-56 overflow-y-auto">
              {branches.map((name, index) => (
                <button
                  type="button"
                  role="option"
                  aria-selected={name === value}
                  tabIndex={-1}
                  id={`${id}-option-${index}`}
                  key={name}
                  onClick={() => select(name)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-muted',
                    highlighted === index && 'bg-muted',
                  )}
                >
                  <span className="min-w-0 flex-1 truncate font-mono" title={name}>
                    {name}
                  </span>
                  {name === defaultBranch ? <span className="text-xs text-muted-foreground">默认</span> : null}
                  {name === value ? <Check aria-hidden="true" className="shrink-0 text-accent" /> : null}
                </button>
              ))}
            </div>
            {!searching && query.hasNextPage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full"
                loading={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              >
                {query.isFetchNextPageError ? '重试加载更多' : '加载更多分支'}
              </Button>
            ) : null}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      {!open && initialError ? <ErrorNotice error={query.error} title="分支加载失败" /> : null}
      {!open && ready && query.isSuccess && first?.branches.length === 0 && !settledSearch ? (
        <p role="status" className="text-xs text-muted-foreground">
          这个仓库暂无分支。
        </p>
      ) : null}
    </Field>
  );
}
