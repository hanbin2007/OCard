# macOS 签名 + 公证(现行方案)

Release 工作流(`.github/workflows/release.yml`)的 `release-macos` job 负责签名+公证:

- **fail-closed**:6 项 Secrets 缺任何一项,正式标签构建直接失败,绝不发未签名产物。
- **凭据隔离**:Apple 凭据只进 macOS job,Linux/Windows job 接触不到。
- **构建后验证**:`codesign --verify` / `spctl -a` / `stapler validate` 三关全过才算合格。
- runner 固定 `macos-15`,tauri-action 固定 `v1`,升级由 Dependabot PR 触发、人工验证后合入。

## 所需 Secrets(6 项)

| Secret | 内容 |
|---|---|
| `APPLE_CERTIFICATE` | 仅含 Developer ID Application 单一身份的 .p12,base64 |
| `APPLE_CERTIFICATE_PASSWORD` | .p12 密码 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Hanbin Zhang (NCLY9ZGRMZ)` |
| `APPLE_ID` | 开发者账号邮箱(Team NCLY9ZGRMZ) |
| `APPLE_PASSWORD` | 该账号下生成的 App 专用密码(account.apple.com → 登录与安全) |
| `APPLE_TEAM_ID` | `NCLY9ZGRMZ` |

## 证书更新(五年一次,Developer ID 到期时)

**用钥匙串访问 GUI 导出,不要再走 openssl:**

1. 钥匙串访问 → 我的证书 → 只选中 `Developer ID Application` 那一条(确认可展开出私钥)→ 导出 → .p12,设强密码。
2. 验收:导入一个临时钥匙串应显示 `1 identity imported`(单一签名身份;附带中间证书链是正常的)。
3. `gh secret set APPLE_CERTIFICATE --body "$(base64 -i 新.p12)"`,同步更新密码 Secret。

`scripts/refresh-apple-cert-secret.sh` 是全自动的备用方案(security export 全量导出 + openssl `-legacy` 拆解重组),能用但脆弱,优先 GUI。

## 可选升级:App Store Connect Team API Key 公证

用 `APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH` 替换 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID`,与个人 Apple ID 和 App 专用密码解耦(须用 **Team Key**,Individual Key 不能用于 notarytool)。在 App Store Connect → 用户和访问 → 集成 里创建,拿到 Issuer ID、Key ID 和 .p8 文件后改 workflow 三个 env 即可。

## 验证一次发布

```bash
spctl -a -vv OCard.app          # accepted / Notarized Developer ID
xcrun stapler validate OCard.app
```
