[CmdletBinding()]
param(
  [string]$InstallRoot = "",
  [string]$ReleaseTag = "",
  [string]$CodexCommand = "codex"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$repository = "renoir1220/esse"
$marketplaceName = "esse-local"
$downloadRoot = $null
$previousCatalog = $null
$previousMarketplaceRoot = $null
$registeredStableMarketplace = $false
$codexExecutable = $null

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Resolve-FullPath([string]$Path) {
  return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]@("\", "/"))
}

function Invoke-Codex([string[]]$Arguments) {
  $output = (& $script:codexExecutable @Arguments 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "codex $($Arguments -join ' ') failed: $output"
  }
  return $output
}

function Expand-ZipSafely([string]$ArchivePath, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  $destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd("\") + "\"
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    foreach ($entry in $archive.Entries) {
      $candidate = [IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
      if (-not $candidate.StartsWith($destinationRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Release archive contains an unsafe path: $($entry.FullName)"
      }
    }
  } finally {
    $archive.Dispose()
  }
  [IO.Compression.ZipFile]::ExtractToDirectory($ArchivePath, $Destination)
}

function Get-WindowsArchitecture {
  $architecture = $null
  try {
    $architecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
  } catch {
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  }
  if ($architecture -notmatch "^(X64|AMD64)$") {
    throw "Esse currently supports Windows x64 only. Detected architecture: $architecture"
  }
}

function Find-MarketplaceRoot([string]$Listing) {
  foreach ($line in ($Listing -split "`r?`n")) {
    if ($line -match "^esse-local\s+(.+)$") {
      return $Matches[1].Trim()
    }
  }
  return $null
}

function Restore-Registration {
  try {
    if ($script:previousCatalog -ne $null) {
      Write-Utf8NoBom -Path $script:catalogPath -Content $script:previousCatalog
    }
    if ($script:registeredStableMarketplace) {
      try { Invoke-Codex @("plugin", "marketplace", "remove", $script:marketplaceName) | Out-Null } catch {}
    }
    if ($script:previousMarketplaceRoot) {
      try { Invoke-Codex @("plugin", "marketplace", "add", $script:previousMarketplaceRoot) | Out-Null } catch {}
    }
  } catch {}
}

try {
  if ($env:OS -ne "Windows_NT") { throw "install.ps1 supports Windows only. Use install.sh on macOS." }
  Get-WindowsArchitecture

  if (-not $InstallRoot) {
    $localAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath("LocalApplicationData") }
    $InstallRoot = Join-Path $localAppData "esse\plugin"
  }
  $InstallRoot = Resolve-FullPath $InstallRoot

  $packageRoot = $PSScriptRoot
  $packageBinary = Join-Path $packageRoot "plugins\esse\bin\esse.exe"
  if (-not (Test-Path -LiteralPath $packageBinary)) {
    $downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ("esse-install-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $downloadRoot -Force | Out-Null
    $releaseBase = if ($ReleaseTag) {
      $tag = if ($ReleaseTag.StartsWith("v")) { $ReleaseTag } else { "v$ReleaseTag" }
      "https://github.com/$repository/releases/download/$tag"
    } else {
      "https://github.com/$repository/releases/latest/download"
    }
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $metadataPath = Join-Path $downloadRoot "latest.json"
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/latest.json" -OutFile $metadataPath
    $metadata = Get-Content -Raw -Encoding UTF8 -LiteralPath $metadataPath | ConvertFrom-Json
    $archiveName = [string]$metadata.windowsX64Asset
    $expectedHash = ([string]$metadata.windowsX64Sha256).ToLowerInvariant()
    if (-not $archiveName -or $expectedHash -notmatch "^[0-9a-f]{64}$") { throw "latest.json does not contain a valid Windows x64 asset." }
    $archivePath = Join-Path $downloadRoot $archiveName
    Invoke-WebRequest -UseBasicParsing -Uri "$releaseBase/$archiveName" -OutFile $archivePath
    $actualHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) { throw "SHA256 mismatch for $archiveName. Expected $expectedHash, got $actualHash." }
    $packageRoot = Join-Path $downloadRoot "package"
    Expand-ZipSafely -ArchivePath $archivePath -Destination $packageRoot
    $packageBinary = Join-Path $packageRoot "plugins\esse\bin\esse.exe"
  }

  $packageMarketplace = Join-Path $packageRoot ".agents\plugins\marketplace.json"
  $pluginSource = Join-Path $packageRoot "plugins\esse"
  $manifestPath = Join-Path $pluginSource ".codex-plugin\plugin.json"
  $widgetPath = Join-Path $pluginSource "mcp\widget.html"
  foreach ($required in @($packageMarketplace, $packageBinary, $manifestPath, $widgetPath)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Release package is missing required file: $required" }
  }

  $manifest = Get-Content -Raw -Encoding UTF8 -LiteralPath $manifestPath | ConvertFrom-Json
  $version = [string]$manifest.version
  if ($version -notmatch "^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$") { throw "Release manifest has an invalid version: $version" }

  $selfTestData = Join-Path ([IO.Path]::GetTempPath()) ("esse-self-test-" + [guid]::NewGuid().ToString("N"))
  $oldDataDir = $env:ESSE_DATA_DIR
  try {
    $env:ESSE_DATA_DIR = $selfTestData
    Push-Location $pluginSource
    try {
      $previousErrorActionPreference = $ErrorActionPreference
      try {
        # Windows PowerShell 5 turns native stderr into non-terminating ErrorRecord
        # objects. Esse logs its readiness message to stderr during self-test, so
        # capture both streams and judge the native process by its exit code.
        $ErrorActionPreference = "Continue"
        $selfTestOutput = (& $packageBinary --self-test 2>&1 | ForEach-Object { "$_" } | Out-String).Trim()
        $selfTestExitCode = $LASTEXITCODE
      } finally {
        $ErrorActionPreference = $previousErrorActionPreference
      }
      if ($selfTestExitCode -ne 0 -or $selfTestOutput -notmatch '"status"\s*:\s*"ok"') { throw "Esse runtime self-test failed: $selfTestOutput" }
    } finally {
      Pop-Location
    }
  } finally {
    $env:ESSE_DATA_DIR = $oldDataDir
    if (Test-Path -LiteralPath $selfTestData) { Remove-Item -LiteralPath $selfTestData -Recurse -Force }
  }

  New-Item -ItemType Directory -Path (Join-Path $InstallRoot "versions") -Force | Out-Null
  $versionRoot = Join-Path $InstallRoot "versions\$version"
  $targetPlugin = Join-Path $versionRoot "plugins\esse"
  if (-not (Test-Path -LiteralPath (Join-Path $targetPlugin "bin\esse.exe") -PathType Leaf)) {
    $stagingRoot = Join-Path $InstallRoot (".staging-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path (Join-Path $stagingRoot "plugins") -Force | Out-Null
    Copy-Item -LiteralPath $pluginSource -Destination (Join-Path $stagingRoot "plugins\esse") -Recurse -Force
    if (Test-Path -LiteralPath $versionRoot) { Remove-Item -LiteralPath $versionRoot -Recurse -Force }
    Move-Item -LiteralPath $stagingRoot -Destination $versionRoot
  }

  $catalogPath = Join-Path $InstallRoot ".agents\plugins\marketplace.json"
  New-Item -ItemType Directory -Path (Split-Path -Parent $catalogPath) -Force | Out-Null
  if (Test-Path -LiteralPath $catalogPath) { $previousCatalog = Get-Content -Raw -Encoding UTF8 -LiteralPath $catalogPath }
  $catalog = Get-Content -Raw -Encoding UTF8 -LiteralPath $packageMarketplace | ConvertFrom-Json
  $catalog.plugins[0].source.path = "./versions/$version/plugins/esse"
  Write-Utf8NoBom -Path $catalogPath -Content ($catalog | ConvertTo-Json -Depth 12)

  $codexExecutable = (Get-Command $CodexCommand -ErrorAction Stop).Source
  $marketplaceListing = Invoke-Codex @("plugin", "marketplace", "list")
  $existingRoot = Find-MarketplaceRoot $marketplaceListing
  $stableRoot = Resolve-FullPath $InstallRoot
  if ($existingRoot -and (Resolve-FullPath $existingRoot) -ne $stableRoot) {
    $previousMarketplaceRoot = $existingRoot
    Invoke-Codex @("plugin", "marketplace", "remove", $marketplaceName) | Out-Null
    $existingRoot = $null
  }
  if (-not $existingRoot) {
    Invoke-Codex @("plugin", "marketplace", "add", $stableRoot) | Out-Null
    $registeredStableMarketplace = $true
  }
  Invoke-Codex @("plugin", "add", "esse@$marketplaceName") | Out-Null
  $pluginListing = Invoke-Codex @("plugin", "list")
  if ($pluginListing -notmatch "esse@esse-local\s+installed, enabled\s+$([regex]::Escape($version))") {
    throw "Codex did not report esse@esse-local as installed and enabled at version $version."
  }

  $receipt = [ordered]@{
    schemaVersion = 1
    repository = "https://github.com/$repository"
    version = $version
    installedAt = [DateTime]::UtcNow.ToString("o")
    pluginPath = $targetPlugin
  }
  Write-Utf8NoBom -Path (Join-Path $InstallRoot "install-receipt.json") -Content ($receipt | ConvertTo-Json -Depth 4)

  Write-Host "Esse $version installed and enabled." -ForegroundColor Green
  Write-Host "Restart the Codex/ChatGPT desktop app, start a new task, and say: Open Esse settings"
  Write-Host "Choose Codex 生成, or configure an optional Provider in the Esse settings UI. Never paste a Provider API Key into chat."
  $result = [ordered]@{ status = "installed"; version = $version; marketplace = $marketplaceName; installRoot = $InstallRoot; restartRequired = $true }
  Write-Output "ESSE_INSTALL_RESULT=$(($result | ConvertTo-Json -Compress))"
} catch {
  if ($codexExecutable) { Restore-Registration }
  $failure = [ordered]@{ status = "failed"; message = $_.Exception.Message }
  Write-Output "ESSE_INSTALL_RESULT=$(($failure | ConvertTo-Json -Compress))"
  throw
} finally {
  if ($downloadRoot -and (Test-Path -LiteralPath $downloadRoot)) {
    Remove-Item -LiteralPath $downloadRoot -Recurse -Force
  }
}
