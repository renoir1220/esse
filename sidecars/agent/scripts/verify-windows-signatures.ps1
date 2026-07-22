$ErrorActionPreference = 'Stop'

$sidecarRoot = Split-Path -Parent $PSScriptRoot
$product = Get-Content -Raw -Encoding UTF8 (Join-Path $sidecarRoot 'product.json') | ConvertFrom-Json
$targets = @(
  (Join-Path $sidecarRoot ("out\{0}-win32-x64\{1}.exe" -f $product.displayName, $product.executableName)),
  (Join-Path $sidecarRoot ("out\make\squirrel.windows\x64\{0}" -f $product.windowsSetupExe))
)

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target)) {
    throw "Missing Windows release artifact: $target"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $target
  if ($signature.Status -ne 'Valid') {
    throw "Invalid Authenticode signature for ${target}: $($signature.Status)"
  }
  if (-not $signature.SignerCertificate) {
    throw "Missing Authenticode signer certificate for $target"
  }
  if (-not $signature.TimeStamperCertificate) {
    throw "Missing trusted Authenticode timestamp for $target"
  }

  Write-Output "$target is signed by $($signature.SignerCertificate.Subject)"
}
