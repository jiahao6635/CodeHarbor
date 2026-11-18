import { useConsoleConfig } from '@/api/hooks';
import { useAbility } from '@/auth/session';
import { CopyButton } from '@/components/copy-button';
import { PageHeader } from '@/components/page-header';
import { Alert } from '@/components/ui/alert';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { mcpEndpoint, mcpOnSeparateAddress } from '@/lib/mcp';

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
  const mcpUrl = mcpEndpoint(config.data, window.location.origin);
  const separateAddress = mcpOnSeparateAddress(config.data, window.location.origin);

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
        {separateAddress ? (
          <Alert tone="warning" title="MCP 使用单独的地址">
            MCP 不在当前控制台域名下提供，需要通过下方地址访问；控制台能打开不代表 MCP 地址可达。
            {config.data?.mcp_url ? null : ' 管理员尚未配置 MCP 地址（CODEHARBOR_UI_MCP_URL），请向管理员确认。'}
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
            <div>
              <CardTitle>可用工具（9 个）</CardTitle>
              <CardDescription>
                7 个代码工具均需传入 repo_id；file/path 使用仓库相对路径，不能传 projectPath。源码对应服务器已发布的
                indexed_commit，不是本机工作区文件。
              </CardDescription>
            </div>
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
              <dd className="text-muted-foreground">
                优先使用：传入 query，一次返回相关源码与调用关系；支持 maxFiles。
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs">codegraph_search</dt>
              <dd className="text-muted-foreground">按 query 搜索符号位置，支持 kind 类型过滤与 limit。</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">codegraph_callers</dt>
              <dd className="text-muted-foreground">查询谁调用 symbol；支持 file 消歧与 limit。</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">codegraph_callees</dt>
              <dd className="text-muted-foreground">查询 symbol 调用了谁；支持 file 消歧与 limit。</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">codegraph_impact</dt>
              <dd className="text-muted-foreground">分析修改 symbol 的影响范围；支持 file 与 depth（最多 10 层）。</dd>
            </div>
            <div>
              <dt className="font-mono text-xs">codegraph_node</dt>
              <dd className="text-muted-foreground">
                传 file 读取带行号的源码，支持 offset、limit、symbolsOnly；传 symbol 查看定义与调用链，支持
                includeCode、file、line。
              </dd>
            </div>
            <div>
              <dt className="font-mono text-xs">codegraph_files</dt>
              <dd className="text-muted-foreground">
                列出索引目录树，支持 path、pattern、format、includeMetadata 与 maxDepth。
              </dd>
            </div>
          </dl>
        </Card>
      </div>
    </>
  );
}
