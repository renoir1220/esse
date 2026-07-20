[CmdletBinding()]
param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CodexArguments
)

$ErrorActionPreference = "Stop"
$commandLine = ($CodexArguments -join " ").Trim()
if ($env:ESSE_FAKE_CODEX_LOG) {
  Add-Content -LiteralPath $env:ESSE_FAKE_CODEX_LOG -Value $commandLine -Encoding UTF8
}

switch -Regex ($commandLine) {
  '^plugin marketplace list$' { exit 0 }
  '^plugin marketplace (add|remove) .+$' { exit 0 }
  '^plugin add .+$' { exit 0 }
  '^plugin list$' {
    if (-not $env:ESSE_FAKE_PLUGIN_VERSION) { throw "ESSE_FAKE_PLUGIN_VERSION is required." }
    Write-Output "esse@esse-local installed, enabled $env:ESSE_FAKE_PLUGIN_VERSION"
    exit 0
  }
  default {
    Write-Error "Unexpected fake Codex arguments: $commandLine"
    exit 2
  }
}
