# CodeHarbor 新手操作：从绑定到查询

你不需要下载 CodeHarbor 的代码，也不需要安装开发工具。本文前七步全部在浏览器的 Swagger 页面完成：绑定云效账号、接入仓库、等待服务器构建索引，以及创建查询密钥。

最后一步以 Postman 为例进行查询，运行 Postman 的电脑需要能够访问公司内网。Swagger 公网管理页面本身不能代替 MCP 客户端。

## 开始之前

准备好：

1. 打开管理页面：[CodeHarbor Swagger 接口文档](https://codegraph.sigmob.com/docs)。建议使用自己的可信电脑和浏览器，确认地址栏是 `https://codegraph.sigmob.com`。
2. 准备你自己的云效个人访问令牌，简称 **PAT**。它需要有云效账号、仓库读取和 Git 克隆权限。如果你还没有 PAT，请先在云效创建，或请云效管理员协助。令牌不要发送到聊天中。
3. 确认想接入的仓库名称，以及要索引的分支名，例如 `main`。不知道仓库数字 ID 没关系，后面可以查询。

页面里 `POST`、`GET` 是接口类型，后面的路径是接口名称。每一步都可以按名称展开对应接口，点击 **Try it out**（试一试），填写内容后点击 **Execute**（执行）。执行结果在下面的 **Server response / Response body**（服务器响应）区域。

> 此操作需要在可信浏览器的请求框输入 PAT 和密钥。Swagger 可能在页面显示含秘密的请求内容或生成的 `curl` 命令；不要截图分享这些内容，也不要把它们粘贴到聊天、工单或群里。用完后关闭页面或清除输入，密钥保存在公司的安全位置。

## 第 1 步：绑定云效账号

1. 在 Swagger 页面找到 **认证** 下的 `POST /api/v1/auth/yunxiao/bind`，点击这一行展开。
2. 点击 **Try it out**。在 **Request body**（请求内容）框中输入下面的内容，将 `这里填你的云效PAT` 替换为自己的真实 PAT，保留两侧双引号：

   ```json
   {
     "pat": "这里填你的云效PAT"
   }
   ```

3. 点击 **Execute**。看到状态码 **200**，表示绑定成功。响应中有一个 `bootstrap_token`，例如：

   ```json
   {
     "bootstrap_token": "这里显示一次性令牌",
     "expires_in": 300,
     "user": { "id": "云效用户ID", "name": "用户名" }
   }
   ```

4. 复制 `bootstrap_token` 的值，**不复制两侧引号**。它是临时令牌，有效 5 分钟，成功使用一次后失效。现在立刻进行下一步。

如果返回 401、403 或其他错误，检查 PAT 是否有效，以及云效组织、用户和仓库权限。如果第 2 步时临时令牌已过期，需要重新执行本步骤并使用新的 `bootstrap_token`。

## 第 2 步：创建管理密钥

管理密钥用于接入仓库和创建查询密钥。它不能直接用于 MCP 查询。

1. 点击 Swagger 页面上方的 **Authorize**（授权）。在名为 **BootstrapBearer** 的输入框里粘贴刚才的 `bootstrap_token`；只填令牌本身，不要加引号或 `Bearer ` 前缀。
2. 点击 **BootstrapBearer** 对应的 **Authorize** 按钮，再点击 **Close** 关闭弹窗。
3. 在 **认证** 下展开 `POST /api/v1/auth/bootstrap/keys`，点击 **Try it out**。将请求内容改为：

   ```json
   {
     "scope": "write",
     "expires_in": 2592000
   }
   ```

   `write` 表示管理权限；`2592000` 秒是 30 天。它不授予修改云效代码的权限。
4. 点击 **Execute**。看到状态码 **201** 后，找到响应中的 `token`：

   ```json
   {
     "token": "这里显示管理密钥",
     "prefix": "密钥前缀",
     "scope": "write",
     "expires_in": 2592000
   }
   ```

5. 把 `token` 的值复制并安全保存。**这就是管理密钥，只在创建成功时显示一次**；它不是刚才的临时令牌，也不是云效 PAT。

如果返回 **403**，你的云效用户可能没有被加入 CodeHarbor 的管理白名单。请管理员核对 `CODEHARBOR_WRITE_USERS`，不要把 PAT 发给管理员。当前服务配置中已有一个白名单身份，但未验证你绑定的账号是否属于该身份。如果返回 **401**，临时令牌可能已经过期或使用过，请回到第 1 步重新绑定。

## 第 3 步：在页面使用管理密钥

1. 再次点击页面上方 **Authorize**。找到 **ApiKey** 输入框，填入第 2 步得到的**管理密钥**，只填密钥本身，不要加引号或 `Bearer `。
2. 点击 **ApiKey** 对应的 **Authorize**，再点击 **Close**。此后管理接口会使用这个密钥。不要把 PAT 或 `bootstrap_token` 填到 `ApiKey`。
3. 展开 **认证** 下的 `GET /api/v1/me`，点击 **Try it out**、**Execute**。
4. 看到 **200**，并且响应里 `key_scope` 为 `write`，说明管理密钥可用。

若返回 401，请检查是否填错或过期；若页面保存的是旧密钥，可在 **Authorize** 弹窗先对 `ApiKey` 点击 **Logout**，再填入当前管理密钥并授权。

## 第 4 步：找到云效仓库 ID

如果已经知道目标仓库的**云效数字 ID**，可以直接进入第 5 步。

1. 展开 **云效仓库** 下的 `GET /api/v1/codeup/repositories`。
2. 点击 **Try it out**，`page` 填 `1`，然后点击 **Execute**。
3. 在响应的 `repositories` 列表中，按 `name`（名称）或 `path`（路径）找到目标仓库，记下它的 `id`。例如：

   ```json
   {
     "repositories": [
       { "id": "123456", "name": "示例仓库", "path": "组织/示例仓库" }
     ],
     "next_page": null
   }
   ```

   此例中云效仓库 ID 是 `123456`。请使用你自己看到的数字，不要照抄示例。
4. 如果 `next_page` 不是 `null`，将它显示的数字填入 `page` 并再次执行，直到找到目标仓库。

列表里能看到仓库不一定意味着有克隆权限；接入时系统还会检查。

## 第 5 步：接入仓库并启动索引构建

1. 展开 **仓库与索引** 下的 `POST /api/v1/repositories`，点击 **Try it out**。
2. 填写请求内容，把数字和分支替换为自己的实际值：

   ```json
   {
     "codeup_repository_id": "123456",
     "branch": "main",
     "authorize_automatic_sync": true
   }
   ```

   `codeup_repository_id` 填第 4 步的云效数字 ID；`branch` 填要索引的分支。`authorize_automatic_sync: true` 表示**你同意 CodeHarbor 使用你刚绑定的 PAT 自动拉取和同步这个仓库**；只有同意时才提交。
3. 点击 **Execute**。首次接入成功通常返回 **202**。记录响应中的两个值：

   - `repository.repo_id`：CodeHarbor 内部仓库 ID，后面创建查询密钥和查询时使用。它与云效数字 ID 不同。
   - `job_id`：本次索引任务 ID，用来查看进度。

   响应还包含 `webhook_path` 和 `webhook_token`。后者只显示一次；如果以后要配置云效 Push Webhook，请立即安全保存。即使暂不配置 Webhook，仍可手动同步，服务也会定期对账。
4. **202 只表示任务已接收，不代表索引已构建完成。** 继续下一步。

如果返回 **404**，检查数字 ID、PAT 读取和克隆权限，以及企业云效的下载管控；请勿把可见仓库等同于可克隆。若返回 **200**，表示仓库已接入，可能不会再次返回新任务或 Webhook 密钥。

## 第 6 步：查看构建进度

1. 展开 `GET /api/v1/jobs/{jobId}`，点击 **Try it out**，在 `jobId` 中填入上一步的 `job_id`，然后点击 **Execute**。
2. 查看响应的 `status`：
   - `queued`：等待处理，可稍后再次点击 **Execute**。
   - `running`：正在构建，可稍后再次查询。
   - `succeeded`：任务成功，继续下面的仓库状态检查。
   - `failed`：任务失败，查看 `error`；检查分支和 PAT 权限后，可通过 `POST /api/v1/repositories/{repoId}/sync` 重试。
3. 展开 `GET /api/v1/repositories/{repoId}`，点击 **Try it out**，在 `repoId` 填第 5 步的 `repository.repo_id`，点击 **Execute**。
4. 确认 `status` 是 `ready`，且 `indexed_commit` 和 `indexed_at` 有值。`stale=false` 是平台的状态报告；如需确认是否为云效最新提交，请在云效对比分支最新 commit。

索引和查询镜像由服务器自动构建，你不需要在本机编译目标仓库。

## 第 7 步：创建 MCP 查询密钥

1. 页面仍使用第 3 步授权的**管理密钥**。展开 **API Key** 下的 `POST /api/v1/api-keys`，点击 **Try it out**。
2. 填写以下内容，把 `repos` 里的文字替换为第 5 步的 **CodeHarbor 内部仓库 ID**，保留双引号：

   ```json
   {
     "scope": "read",
     "repos": ["这里填CodeHarbor内部仓库ID"],
     "expires_in": 604800
   }
   ```

   `read` 表示只读；`604800` 秒为 7 天，不能超过管理密钥的剩余有效期。这里不能填写云效数字 ID。
3. 点击 **Execute**。成功返回 **201** 后，复制响应中的 `token` 并安全保存。**这是 MCP 查询密钥，只显示一次**；它只能查询 `repos` 里列出的仓库。

管理密钥和查询密钥虽然都叫 `token`，用途不同：前者管理仓库，后者交给 MCP 客户端查询。不要把 PAT 或管理密钥交给 MCP 客户端。

## 第 8 步：用 Postman 查询

Swagger 页面显示的 `/mcp` 接口说明属于平台进程，该入口已关闭；MCP 由独立服务提供，经 Nginx 转发到与控制台相同的域名。这里用 Postman 的 MCP 请求连接它。需要 Postman 支持 MCP 请求，并确保运行 Postman 的电脑可以访问公司内网（`codegraph.sigmob.com` 仅内网可达）。以下操作基于 [Postman 官方 MCP 请求说明](https://learning.postman.com/docs/use/send-requests/protocols/mcp-requests/create)，不同版本的界面名称可能略有不同。

1. 打开 Postman 桌面版，进入一个工作区。在左侧选择 **Add → MCP**，创建 MCP 请求；有些版本入口为 **New → MCP**。
2. 选择 **HTTP**，在地址栏填写 `https://codegraph.sigmob.com/mcp`。旧的内网端口 `http://10.29.23.237:18080/mcp` 暂时仍可用，但其中的 Key、查询和结果以明文传输，只能在可信网络使用。
3. 打开请求的 **Authorization** 标签，在 **Auth Type** 选择 **Bearer Token**。在 **Token** 填入第 7 步的**查询密钥**，只填密钥本身，不要输入 `Bearer ` 前缀；Postman 会自动添加。不要填写云效 PAT 或管理密钥。建议将密钥保存在 [Postman 本地保管库](https://learning.postman.com/docs/use/postman-vault/manage-vault-secrets)，不要将其分享到工作区或聊天。
4. 点击 **Load Capabilities**（部分版本叫 **Load Methods**）。Postman 会连接服务并加载工具；如果看到访问许可提示，检查后按界面完成授权。
5. 在 **Tools** 中选择 `list_repositories`，参数填写 `{}`，点击 **Run**。在 **Response** 中检查是否出现新仓库。
6. 选择 `get_repository_status`，将下面的文字替换为第 5 步得到的 CodeHarbor 内部仓库 ID，然后点击 **Run**：

   ```json
   {"repo_id": "这里填CodeHarbor内部仓库ID"}
   ```

7. 选择 `codegraph_explore`，填写相同仓库 ID 和想查询的函数名或代码问题，再点击 **Run**：

   ```json
   {"repo_id": "这里填CodeHarbor内部仓库ID", "query": "这里填函数名或代码问题"}
   ```

加载后应看到 9 个工具：两个仓库工具，以及 `codegraph_search`、`codegraph_callers`、`codegraph_callees`、`codegraph_impact`、`codegraph_node`、`codegraph_explore`、`codegraph_files`。所有代码工具都必须填写 `repo_id`；可选参数以 Postman 加载的工具定义为准。`codegraph_node` 仅填 `file` 可读取带行号的文件源码，填 `symbol` 可查看符号详情；`file` 和 `path` 使用仓库相对路径，不能输入本机绝对路径或 `projectPath`。源码对应服务器的 `indexed_commit`，不是本机工作区。

查询结果显示在 **Response** 中。若没有 MCP 请求入口，请检查 Postman 版本。若连接超时，请先核对电脑到内网地址的访问；其他 ECS 和本机直连尚未验证，必要时请网络运维协助。如果返回 401，检查查询密钥是否正确或过期；如果提示仓库不存在或无权访问，检查密钥的 `repos` 是否包含正确的内部 ID，以及第 6 步的索引状态。

查询时系统依据 CodeHarbor 查询密钥的仓库范围授权，不会每次重新检查云效权限。云效撤权或 PAT 失效后，原查询密钥不会自动失效；需要管理员通过 `DELETE /api/v1/api-keys/{prefix}` 撤销。服务器重置前的 CodeHarbor Key 和 Webhook 已失效。
