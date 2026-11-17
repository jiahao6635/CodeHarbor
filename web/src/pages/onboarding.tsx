import { zodResolver } from '@hookform/resolvers/zod';
import { Check, Eye, EyeSlash } from '@phosphor-icons/react';
import { useEffect, useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { z } from 'zod';
import { ApiError } from '@/api/client';
import { bindYunxiao, createBootstrapKey, fetchMeWith } from '@/api/hooks';
import type { BootstrapKey, BootstrapSession, Scope } from '@/api/types';
import { useSession } from '@/auth/session';
import { AuthLayout } from '@/components/auth-layout';
import { SecretReveal } from '@/components/secret-reveal';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input, NativeSelect } from '@/components/ui/input';
import { describedBy, Field } from '@/components/ui/label';
import { cn } from '@/lib/cn';
import { describeError } from '@/lib/errors';
import { formatKeyLifetime } from '@/lib/format';
import { toastError } from '@/lib/toast';
import { DEFAULT_EXPIRES_IN, EXPIRY_OPTIONS, parseExpiry, pat, UNLIMITED_EXPIRY_HELP } from '@/lib/validation';

const STEPS = ['绑定云效账号', '申请 Key', '保存 Key'] as const;

function Stepper({ current }: { current: number }) {
  return (
    <ol className="flex items-center gap-2" aria-label="步骤">
      {STEPS.map((label, index) => {
        const state = index < current ? 'done' : index === current ? 'current' : 'todo';
        return (
          <li
            key={label}
            className="flex flex-1 items-center gap-2"
            aria-current={state === 'current' ? 'step' : undefined}
          >
            <span
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors duration-200',
                state === 'done' && 'border-accent bg-accent text-accent-foreground',
                state === 'current' && 'border-accent text-accent',
                state === 'todo' && 'border-border text-muted-foreground',
              )}
            >
              {state === 'done' ? <Check weight="bold" aria-hidden="true" /> : index + 1}
            </span>
            <span className={cn('text-sm', state === 'todo' ? 'text-muted-foreground' : 'font-medium')}>{label}</span>
            {index < STEPS.length - 1 ? <span className="mx-1 h-px flex-1 bg-border" aria-hidden="true" /> : null}
          </li>
        );
      })}
    </ol>
  );
}

const bindSchema = z.object({ pat });
type BindValues = z.infer<typeof bindSchema>;

function BindStep({ onBound }: { onBound: (session: BootstrapSession) => void }) {
  const [visible, setVisible] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<BindValues>({ resolver: zodResolver(bindSchema), defaultValues: { pat: '' } });
  const onSubmit = form.handleSubmit(async (values) => {
    setServerError(null);
    try {
      const session = await bindYunxiao(values.pat);
      // The PAT leaves component state as soon as the server has it.
      form.reset({ pat: '' });
      onBound(session);
    } catch (error) {
      setServerError(error instanceof ApiError ? describeError(error.code) : '无法连接到服务。');
    }
  });
  const error = form.formState.errors.pat?.message;
  return (
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">绑定云效账号</h2>
        <p className="text-sm text-muted-foreground">
          输入你的云效个人访问令牌（PAT）。令牌仅用于验证身份并加密保存在服务端，用于拉取你有权限的仓库；本页面不会保存它。
        </p>
      </div>
      {serverError ? <Alert tone="error">{serverError}</Alert> : null}
      <Field
        id="pat"
        label="云效个人访问令牌（PAT）"
        helper="需要用户信息读取、仓库只读与 HTTPS Git 读取权限；具体 scope 以企业云效版本为准。"
        error={error}
      >
        <div className="flex gap-2">
          <Input
            id="pat"
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            autoFocus
            aria-invalid={error ? true : undefined}
            aria-describedby={describedBy('pat', { helper: true, error: !!error })}
            {...form.register('pat')}
          />
          <Button
            type="button"
            variant="secondary"
            size="icon"
            onClick={() => setVisible((value) => !value)}
            aria-pressed={visible}
            aria-label={visible ? '隐藏令牌' : '显示令牌'}
          >
            {visible ? <EyeSlash /> : <Eye />}
          </Button>
        </div>
      </Field>
      <Alert tone="warning">
        只有更换为不同的
        PAT，才会使你此前授权同步的仓库进入「需重新授权」状态，需要在仓库详情页重新授权一次；重新绑定同一个 PAT
        不影响已有同步授权。
      </Alert>
      <div className="flex justify-end">
        <Button type="submit" loading={form.formState.isSubmitting}>
          验证并绑定
        </Button>
      </div>
    </form>
  );
}

function KeyStep({
  session,
  onCreated,
  onExpired,
}: {
  session: BootstrapSession;
  onCreated: (key: BootstrapKey) => void;
  onExpired: () => void;
}) {
  const [scope, setScope] = useState<Scope>('read');
  const [expiresIn, setExpiresIn] = useState<number | null>(DEFAULT_EXPIRES_IN);
  const [submitting, setSubmitting] = useState(false);
  const [remaining, setRemaining] = useState(session.expires_in);
  const scopeId = useId();
  const expiryId = useId();
  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      const left = session.expires_in - Math.floor((Date.now() - started) / 1000);
      setRemaining(left);
      if (left <= 0) {
        window.clearInterval(timer);
        onExpired();
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [session.expires_in, onExpired]);

  const submit = async () => {
    setSubmitting(true);
    try {
      onCreated(await createBootstrapKey(session.bootstrap_token, { scope, expires_in: expiresIn }));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        onExpired();
        return;
      }
      toastError(error, '申请 Key 失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold">申请 Key</h2>
        <p className="text-sm text-muted-foreground">
          已验证云效账号 <span className="font-medium text-foreground">{session.user.name}</span>。引导令牌剩余{' '}
          <span className="tabular font-medium text-foreground">{Math.max(remaining, 0)}</span> 秒，过期需重新绑定。
        </p>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium" id={scopeId}>
          Key 类型
        </legend>
        <ScopeOption
          name="scope"
          value="read"
          checked={scope === 'read'}
          onChange={() => setScope('read')}
          title="read（推荐）"
          description="查询你当前在云效中有权限的已接入仓库；可配置给 MCP 客户端使用。"
        />
        <ScopeOption
          name="scope"
          value="write"
          checked={scope === 'write'}
          onChange={() => setScope('write')}
          title="write"
          description="接入仓库、触发索引与平台管理；需要管理员预先将你的云效用户 ID 加入 CODEHARBOR_WRITE_USERS，否则会被拒绝。write Key 本身不能查询代码。"
        />
      </fieldset>
      <Field id={expiryId} label="有效期" helper={expiresIn === null ? UNLIMITED_EXPIRY_HELP : undefined}>
        <NativeSelect
          id={expiryId}
          value={String(expiresIn)}
          onChange={(event) => setExpiresIn(parseExpiry(event.target.value))}
          aria-describedby={describedBy(expiryId, { helper: expiresIn === null })}
        >
          {EXPIRY_OPTIONS.map((option) => (
            <option key={String(option.seconds)} value={String(option.seconds)}>
              {option.label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="flex justify-end">
        <Button onClick={submit} loading={submitting}>
          创建 Key
        </Button>
      </div>
    </div>
  );
}

function ScopeOption({
  title,
  description,
  ...props
}: { title: string; description: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer gap-3 rounded-md border p-3 transition-colors duration-150 hover:bg-muted/60',
        props.checked ? 'border-accent' : 'border-border',
      )}
    >
      <input id={id} type="radio" className="mt-1 size-4 shrink-0 accent-[var(--color-accent)]" {...props} />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

export default function OnboardingPage() {
  const [step, setStep] = useState(0);
  const [session, setSession] = useState<BootstrapSession | null>(null);
  const [created, setCreated] = useState<BootstrapKey | null>(null);
  const [expiredNotice, setExpiredNotice] = useState(false);
  const { signIn } = useSession();
  const navigate = useNavigate();

  const finish = async () => {
    if (!created) return;
    try {
      const me = await fetchMeWith(created.token);
      signIn(created.token, me);
      setCreated(null);
      navigate('/repositories', { replace: true });
    } catch (error) {
      toastError(error, '自动登录失败，请使用刚才保存的 Key 手动登录');
      navigate('/login', { replace: true });
    }
  };

  return (
    <AuthLayout width="md">
      <Card className="flex flex-col gap-6 p-6">
        <Stepper current={step} />
        {expiredNotice ? <Alert tone="warning">引导令牌已过期（有效期 5 分钟），请重新绑定。</Alert> : null}
        {step === 0 ? (
          <BindStep
            onBound={(value) => {
              setSession(value);
              setExpiredNotice(false);
              setStep(1);
            }}
          />
        ) : null}
        {step === 1 && session ? (
          <KeyStep
            session={session}
            onCreated={(key) => {
              setCreated(key);
              setSession(null);
              setStep(2);
            }}
            onExpired={() => {
              setSession(null);
              setExpiredNotice(true);
              setStep(0);
            }}
          />
        ) : null}
        {step === 2 ? (
          <div className="flex flex-col gap-2">
            <h2 className="text-lg font-semibold">保存 Key</h2>
            <p className="text-sm text-muted-foreground">请在弹出的窗口中保存 Key，确认后将自动登录。</p>
          </div>
        ) : null}
      </Card>
      <p className="text-center text-sm text-muted-foreground">
        已有 Key？
        <Link to="/login" className="ml-1 text-accent underline-offset-4 hover:underline">
          直接登录
        </Link>
      </p>
      <SecretReveal
        open={created !== null}
        title="你的 CodeHarbor Key"
        description={
          created
            ? `类型 ${created.scope}，前缀 ${created.prefix}，有效期 ${formatKeyLifetime(created.expires_in)}。`
            : ''
        }
        items={created ? [{ label: 'CodeHarbor Key', value: created.token }] : []}
        onClose={finish}
        confirmLabel="我已妥善保存，登录控制台"
      />
    </AuthLayout>
  );
}
