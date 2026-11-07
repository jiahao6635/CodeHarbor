# Vault Transit 主密钥保护

CodeHarbor 支持以 Vault Transit 包装 PAT 的 32 字节 AES 主密钥。每条 PAT 密文仍由本地 AES-256-GCM 加密，绑定其持有者；存储格式与本地密钥模式相同。切换时包装相同主密钥可直接读取已有密文，无须重新绑定 PAT。

对接使用 [Vault Transit Encrypt/Decrypt API](https://developer.hashicorp.com/vault/api-docs/secret/transit) 和固定的附加认证数据（AAD）。

Vault Transit 密钥驻留 Vault；服务启动时读取 Vault Agent 创建的 token 文件与已包装主密钥文件，通过 HTTPS 解包主密钥。**解包后的主密钥驻留 CodeHarbor 进程内存直至退出**；Vault 撤销访问不会自动令已运行进程中的主密钥失效。需要撤销时停止进程、撤销相应 Vault token，并按企业流程轮换密钥。Vault 不可用时启动失败，绝不退回环境变量中的明文密钥。

## 前提

- 已有可信 HTTPS Vault 服务、Transit 引擎和预先创建的 `aes256-gcm96` 非派生密钥；确认其版本支持 `associated_data`。不使用 CodeHarbor 自动创建或修改 Vault 密钥。
- 使用 Vault Agent 或企业现有机制在受保护路径提供短期 Vault token 文件，配置自动续期和轮换。CodeHarbor 仅在启动时读取一次，不能替代 Vault Agent 的身份认证。
- 在运行节点设定受信 CA。如需企业私有 CA，可在 Node.js 进程启动前设置 `NODE_EXTRA_CA_CERTS`；不得禁用 TLS 校验。Vault 地址必须是 HTTPS origin，不能携带路径、用户名、密码或查询参数。
- 对 CodeHarbor 运行身份仅授予 `transit/decrypt/<key>` 的 `update` 权限；仅初始化/迁移身份需要 `transit/encrypt/<key>` 的 `update` 权限。按实际 mount 名称调整权限；不要赋予创建、删除、导出或轮换 Vault 密钥的权限。

Vault 策略示例（将 `transit` 和 `codeharbor` 替换为实际 mount 和密钥名）：

```hcl
path "transit/decrypt/codeharbor" {
  capabilities = ["update"]
}
```

## 环境变量

| 变量 | 用途 |
|---|---|
| `CODEHARBOR_KEY_PROVIDER=vault-transit` | 显式选择 Vault；未配置时是本地环境变量模式 |
| `CODEHARBOR_VAULT_ADDR` | Vault HTTPS origin，例如 `https://vault.example.com:8200` |
| `CODEHARBOR_VAULT_TRANSIT_MOUNT` | Transit mount 名，默认 `transit`；当前只支持单个路径段 |
| `CODEHARBOR_VAULT_TRANSIT_KEY` | 预先创建的 Transit 密钥名 |
| `CODEHARBOR_VAULT_TOKEN_FILE` | 服务身份的 Vault Agent token 文件路径，不是 token 内容 |
| `CODEHARBOR_VAULT_WRAPPED_KEY_FILE` | 持久化存储的已包装主密钥文件路径 |
| `CODEHARBOR_VAULT_NAMESPACE` | 可选，Vault Enterprise namespace |

部署安全组需允许 CodeHarbor 至 Vault 的 HTTPS 访问，并保护 token 文件、包装密钥文件及数据备份。路径通过配置提供，敏感值不应写入源码、命令参数或日志。建议将运行与初始化 token 隔离，包装完成后删除对初始化 token 的访问。

## 首次部署

在**没有已加密 PAT 的全新数据目录**上，先用有 Transit encrypt 权限的初始化身份执行：

```sh
node dist/vault-key.js --new
```

命令生成随机主密钥并仅将 Vault 密文写入 `CODEHARBOR_VAULT_WRAPPED_KEY_FILE`，文件使用 0600 权限并拒绝覆盖已有文件。保留与数据库一致的加密主密钥文件备份；丢失文件或 Vault 密钥会导致数据无法恢复。然后切换为只具备 decrypt 权限的运行身份，设置 `CODEHARBOR_KEY_PROVIDER=vault-transit` 并启动服务。

## 迁移已有本地主密钥

**不要对现有数据使用 `--new`。** 在停机、备份数据库和原主密钥后，将原 `CODEHARBOR_MASTER_KEY` 通过受控运行环境交给初始化进程，执行：

```sh
node dist/vault-key.js --wrap-existing
```

该命令包装原来的主密钥，不改变数据库内 PAT 密文；拒绝覆盖现有包装密钥文件。使用只读数据库备份先验证原和新方式能解密同一批测试记录。然后移除运行进程的 `CODEHARBOR_MASTER_KEY`，配置 Vault provider 和运行身份，启动并验证。回滚时停机、恢复原配置及密钥，不能丢弃原密钥或依赖未经验证的备份。

Vault Transit 自身轮换密钥版本后，旧版本需要保留以继续解包既有密文；任何收紧 `min_decryption_version`、删除密钥或移除包装文件前必须验证解密和备份恢复。此流程只是用 Vault 保护原 AES 主密钥，不会自动轮换 PAT 加密主密钥，也不会自动重加密历史数据。

## 验证与边界

单元测试模拟 Vault Transit API、权限失败、重定向和密文兼容；上线前必须在企业 Vault 测试环境实际验证 CA 信任、token 自动更新、权限、停机和恢复、代理与网络策略。生产部署还应限制 CodeHarbor 进程和容器访问、日志内容及内存转储。
