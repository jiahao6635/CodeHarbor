import { useConsoleConfig } from '@/api/hooks';
import { useAbility } from '@/auth/session';
import { CopyButton } from '@/components/copy-button';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const PLACEHOLDER = '<CodeHarbor Key>';

function Snippet({ code, label }: { code: string; label: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <CopyButton value={code} />
      </div>
      <pre className="overflow-x-auto rounded-sm border border-border bg-background p-3 text-xs leading-5">
        <code>
          {code.split(PLACEHOLDER).map((part, index, parts) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static split of a constant string
            <span key={index}>
              {part}
              {index < parts.length - 1 ? (
                <mark className="rounded-[3px] bg-status-warning-tint px-1 text-status-warning">{PLACEHOLDER}</mark>
              ) : null}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
}

export default function McpPage() {
  const { me } = useAbility();
  const config = useConsoleConfig();
  const mcpUrl = config.data?.mcp_url ?? `${window.location.origin}/mcp`;
  const publicDisabled = config.data?.public_mcp_disabled ?? false;

  const jsonConfig = JSON.stringify(
    { mcpServers: { codeharbor: { url: mcpUrl, headers: { Authorization: `Bearer ${PLACEHOLDER}` } } } },
    null,
    2,
  );
  const curl = `curl -sS ${mcpUrl} \\\n  -H 'Authorization: Bearer ${PLACEHOLDER}' \\\n  -H 'Content-Type: application/json' \\\n  -H 'Accept: application/json, text/event-stream' \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_repositories","arguments":{}}}'`;

  return (
    <>
      <PageHeader
        title="MCP 接入"
        description="将 CodeHarbor 配置为 Agent 的 MCP 服务器，用 CodeHarbor Key 认证；不要向 Agent 暴露云效 PAT。"
      />
      <div className="flex flex-col gap-4">
        {me?.is_admin ? (
          <Alert tone="info">
            管理 Key（无限定仓库范围的 write Key）不能查询代码。请使用自助 read Key，或在 Key 页面创建限定仓库范围的
            read Key 供 Agent 使用。
          </Alert>
        ) : null}
        {publicDisabled ? (
          <Alert tone="warning" title="公网 MCP 入口已关闭">
            MCP 查询需要通过内网地址访问；控制台能打开不代表 MCP 地址可达。
            {config.data?.mcp_url ? null : ' 管理员尚未配置内网 MCP 地址（CODEHARBOR_UI_MCP_URL），请向管理员确认。'}
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <div>
              <CardTitle>服务地址</CardTitle>
              <CardDescription>
                Streamable HTTP 传输；请求头 Authorization: Bearer &lt;CodeHarbor Key&gt;。
              </CardDescription>
            </div>
            <CopyButton value={mcpUrl} />
          </CardHeader>
          <code className="block break-all rounded-sm bg-muted px-3 py-2 text-sm">{mcpUrl}</code>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>客户端配置</CardTitle>
              <CardDescription>
                将 {PLACEHOLDER} 替换为你的 Key；页面不会自动填充 Key。具体字段以各客户端文档为准。
              </CardDescription>
            </div>
          </CardHeader>
          <Tabs defaultValue="json">
            <TabsList>
              <TabsTrigger value="json">JSON 配置（Claude / Cursor / Qoder）</TabsTrigger>
              <TabsTrigger value="curl">curl 验证</TabsTrigger>
            </TabsList>
            <TabsContent value="json">
              <Snippet label="mcpServers 片段" code={jsonConfig} />
            </TabsContent>
            <TabsContent value="curl">
              <Snippet label="调用 list_repositories 验证连通性" code={curl} />
            </TabsContent>
          </Tabs>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>可用工具</CardTitle>
          </CardHeader>
          <dl className="grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
            <div>
              <dt className="font-mono text-xs">list_repositories</dt>
              <dd className="text-muted-foreground">列出当前 Key 可查询的仓库及索引状态，先调用它获取 repo_id。</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">get_repository_status</dt>
              <dd className="text-muted-foreground">查看单个仓库的索引 commit、新鲜度与状态。</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">codegraph_explore</dt>
              <dd className="text-muted-foreground">传入 repo_id 与 query，按符号、调用关系和源码片段探索代码。</dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
