#!/usr/bin/env bash
# 一次性:从钥匙串导出仅含 Developer ID Application 身份的 p12,更新 GitHub Secrets,
# 并重跑最近一次失败的 Release 工作流。私钥只在本机临时目录停留,结束即删。
set -euo pipefail

IDENTITY="Developer ID Application: Hanbin Zhang (NCLY9ZGRMZ)"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

P12PASS=$(openssl rand -base64 18)

echo "==> 导出钥匙串身份(如弹窗请点「允许」)"
security export -t identities -f pkcs12 -P "$P12PASS" -o "$TMP/all.p12"

echo "==> 抽取 Developer ID 证书与私钥"
openssl pkcs12 -in "$TMP/all.p12" -passin "pass:$P12PASS" -nodes -out "$TMP/dump.pem"

python3 - "$TMP" "$IDENTITY" <<'PY'
import re, sys
tmp, want = sys.argv[1], sys.argv[2]
text = open(f"{tmp}/dump.pem").read()
blocks = re.findall(r'(Bag Attributes[\s\S]*?-----END [A-Z ]+-----\n)', text)
def keyid(b):
    m = re.search(r'localKeyID: ([0-9A-F ]+)', b)
    return m.group(1) if m else None
certs = [b for b in blocks if 'BEGIN CERTIFICATE' in b and want in b]
assert certs, f"未找到证书: {want}"
cert = certs[0]
kid = keyid(cert)
keys = [b for b in blocks if 'PRIVATE KEY' in b and keyid(b) == kid]
assert keys, "未找到与证书配对的私钥"
pem = lambda b: b[b.index('-----BEGIN'):]
open(f"{tmp}/cert.pem", 'w').write(pem(cert))
open(f"{tmp}/key.pem", 'w').write(pem(keys[0]))
print("   证书与私钥配对成功")
PY

# 带上 Apple 中间证书(若本机钥匙串有),保证签名链完整
EXTRA=()
if security find-certificate -c "Developer ID Certification Authority" -p > "$TMP/chain.pem" 2>/dev/null && [ -s "$TMP/chain.pem" ]; then
  EXTRA=(-certfile "$TMP/chain.pem")
  echo "==> 已附带 Developer ID 中间证书"
fi

openssl pkcs12 -export -out "$TMP/devid.p12" -passout "pass:$P12PASS" \
  -inkey "$TMP/key.pem" -in "$TMP/cert.pem" "${EXTRA[@]+"${EXTRA[@]}"}" -name "$IDENTITY"

echo "==> 更新 GitHub Secrets"
gh secret set APPLE_CERTIFICATE --body "$(base64 -i "$TMP/devid.p12")"
gh secret set APPLE_CERTIFICATE_PASSWORD --body "$P12PASS"

echo "==> 重跑失败的 Release 工作流"
RUN_ID=$(gh run list --workflow Release --limit 1 --json databaseId -q '.[0].databaseId')
gh run rerun "$RUN_ID" --failed
echo "✅ 完成:Secrets 已更新,Release 重跑中(run $RUN_ID)"
