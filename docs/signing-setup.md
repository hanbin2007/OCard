# macOS 签名 + 公证配置(一次性)

Release 工作流已接好 tauri-action 的签名入口:下面 6 个 GitHub Secrets 配齐后,打 `v*` 标签的构建会自动签名并送 Apple 公证;不配则跳过签名(产物仍可用,首次右键打开)。

## 1. 准备材料(在你的 Mac 上)

1. **Developer ID Application 证书**
   Xcode → Settings → Accounts → 选你的付费账号 → Manage Certificates → `+` → Developer ID Application。
   (或在 developer.apple.com → Certificates 用 CSR 申请后双击安装。)
2. **导出 .p12**
   钥匙串访问 → 我的证书 → 右键该证书(连同私钥)→ 导出 → 格式 .p12,设一个导出密码。
3. **App 专用密码**(公证用)
   account.apple.com → 登录与安全 → App 专用密码 → 生成一枚。
4. **Team ID**
   developer.apple.com → Membership 页,10 位字符。

## 2. 写入 GitHub Secrets

```bash
cd /path/to/OCard

gh secret set APPLE_CERTIFICATE --body "$(base64 -i ~/Desktop/DeveloperID.p12)"
gh secret set APPLE_CERTIFICATE_PASSWORD --body "<p12 导出密码>"
gh secret set APPLE_SIGNING_IDENTITY --body "Developer ID Application: <你的名字> (<TEAMID>)"
gh secret set APPLE_ID --body "<你的 Apple ID 邮箱>"
gh secret set APPLE_PASSWORD --body "<App 专用密码>"
gh secret set APPLE_TEAM_ID --body "<TEAMID>"
```

`APPLE_SIGNING_IDENTITY` 的准确值可用 `security find-identity -v -p codesigning` 查看。

## 3. 验证

推一个测试标签(如 `v0.0.1`)触发 Release 工作流,macOS 产物下载后:

```bash
spctl -a -vv OCard.app        # 应显示 accepted / Notarized Developer ID
```

## 注意

- .p12 与各密码只进 Secrets,不要提交进仓库。
- Windows 代码签名暂不做(内部使用,SmartScreen 点一次即可)。
