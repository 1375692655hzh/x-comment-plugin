# X Comment Copilot - one-click update (Windows)
# Downloads the latest main.zip from GitHub and replaces the stable install folder.
# Output messages are ASCII-only to avoid encoding issues on Windows PowerShell 5.1.

$ErrorActionPreference = 'Stop'

$repoZip = 'https://github.com/1375692655hzh/x-comment-plugin/archive/refs/heads/main.zip'
$dest    = Join-Path $env:USERPROFILE 'Extensions\xcc-extension'
$zip     = Join-Path $env:TEMP 'xcc-extension.zip'
$tmp     = Join-Path $env:TEMP 'xcc-extract'

Write-Host "== X Comment Copilot updater =="

# Direct first, then common local proxy ports (Clash etc.)
$sources = @(
  @{ Name = 'direct'; Proxy = $null },
  @{ Name = 'proxy 127.0.0.1:7897'; Proxy = 'http://127.0.0.1:7897' },
  @{ Name = 'proxy 127.0.0.1:7890'; Proxy = 'http://127.0.0.1:7890' }
)

$downloaded = $false
foreach ($s in $sources) {
  try {
    Write-Host ("Downloading via " + $s.Name + " ...")
    if ($s.Proxy) {
      Invoke-WebRequest -Uri $repoZip -OutFile $zip -Proxy $s.Proxy -UseBasicParsing -TimeoutSec 40
    } else {
      Invoke-WebRequest -Uri $repoZip -OutFile $zip -UseBasicParsing -TimeoutSec 40
    }
    $downloaded = $true
    break
  } catch {
    Write-Host ("  failed: " + $_.Exception.Message)
  }
}

if (-not $downloaded) {
  Write-Host ''
  Write-Host 'Download failed. Please open this URL in your browser manually:'
  Write-Host $repoZip
  exit 1
}

if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$inner = Join-Path $tmp 'x-comment-plugin-main'
if (-not (Test-Path (Join-Path $inner 'manifest.json'))) {
  Write-Host 'Unexpected zip layout - aborting.'
  exit 1
}

New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null
if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
Move-Item $inner $dest

Write-Host ''
Write-Host ("Updated to latest version at: " + $dest)
Write-Host 'Now open the browser extensions page and click "Reload" on the extension.'
