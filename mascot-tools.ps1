param(
  [ValidateSet('preview', 'sync')]
  [string]$Mode = 'preview',
  [string]$SourcePath = (Join-Path $PSScriptRoot 'src\components\LogoV2\Clawd.tsx'),
  [string]$RuntimePath = (Join-Path $env:APPDATA 'npm\node_modules\@anthropic-ai\claude-code\cli.js')
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $Utf8NoBom

function Read-Utf8Text {
  param([string]$Path)
  return [System.IO.File]::ReadAllText($Path, $Utf8NoBom)
}

function Write-Utf8Text {
  param(
    [string]$Path,
    [string]$Content
  )

  [System.IO.File]::WriteAllText($Path, $Content, $Utf8NoBom)
}

function Get-ClawdArt {
  param([string]$Path)

  $raw = Read-Utf8Text $Path
  $artMatch = [regex]::Match(
    $raw,
    "(?s)const\s+CLAWD_ART:\s*Record<ClawdPose,\s*string\[\]>\s*=\s*(\{.*?\})\s*export\s+function\s+Clawd"
  )

  if (-not $artMatch.Success) {
    throw "Could not find CLAWD_ART in $Path"
  }

  $objectLiteral = $artMatch.Groups[1].Value
  $poses = [ordered]@{}

  foreach ($pose in @('default', 'look-left', 'look-right', 'arms-up')) {
    $keyPattern = if ($pose -eq 'default') { 'default' } else { "'$([regex]::Escape($pose))'" }
    $poseMatch = [regex]::Match($objectLiteral, "(?s)$keyPattern\s*:\s*\[(.*?)\]")

    if (-not $poseMatch.Success) {
      throw "Could not find pose '$pose' in CLAWD_ART"
    }

    $lines = @()
    $stringMatches = [regex]::Matches($poseMatch.Groups[1].Value, "'((?:\\.|[^'])*)'")

    foreach ($stringMatch in $stringMatches) {
      $value = $stringMatch.Groups[1].Value
      $value = $value.Replace("\\", "\")
      $value = $value.Replace("\'", "'")
      $lines += $value
    }

    $poses[$pose] = $lines
  }

  return $poses
}

function Convert-ToRuntimeLiteral {
  param([System.Collections.Specialized.OrderedDictionary]$Art)

  $parts = @()

  foreach ($pose in @('default', 'look-left', 'look-right', 'arms-up')) {
    $runtimeKey = if ($pose -eq 'default') { 'default' } else { '"' + $pose + '"' }
    $runtimeItems = @()

    foreach ($line in $Art[$pose]) {
      $escaped = $line.Replace('\', '\\').Replace('"', '\"')
      $runtimeItems += '"' + $escaped + '"'
    }

    $parts += "${runtimeKey}:[$($runtimeItems -join ',')]"
  }

  return '{' + ($parts -join ',') + '}'
}

function Show-Preview {
  param([System.Collections.Specialized.OrderedDictionary]$Art, [string]$Path)

  Write-Host ""
  Write-Host "Mascot preview from $Path" -ForegroundColor Cyan

  foreach ($pose in @('default', 'look-left', 'look-right', 'arms-up')) {
    $widths = $Art[$pose] | ForEach-Object { $_.Length }
    Write-Host ""
    Write-Host "[$pose] width=$($widths -join '/')" -ForegroundColor Blue
    foreach ($line in $Art[$pose]) {
      Write-Host " $line" -ForegroundColor Blue
    }
  }

  Write-Host ""
  Write-Host "Edit CLAWD_ART in src/components/LogoV2/Clawd.tsx, then rerun this preview." -ForegroundColor DarkGray
}

function Sync-RuntimeMascot {
  param(
    [System.Collections.Specialized.OrderedDictionary]$Art,
    [string]$Path
  )

  if (-not (Test-Path $Path)) {
    throw "Runtime file not found: $Path"
  }

  $raw = Read-Utf8Text $Path
  $pattern = '\{default:\[[^\]]*\],"look-left":\[[^\]]*\],"look-right":\[[^\]]*\],"arms-up":\[[^\]]*\]\}'
  $replacement = Convert-ToRuntimeLiteral $Art

  if (-not [regex]::IsMatch($raw, $pattern)) {
    throw "Could not find the mascot object in $Path"
  }

  $backupPath = "$Path.wrapd-code.backup"
  if (-not (Test-Path $backupPath)) {
    Copy-Item $Path $backupPath -Force
  }

  $updated = [regex]::Replace(
    $raw,
    $pattern,
    [System.Text.RegularExpressions.MatchEvaluator]{
      param($match)
      $replacement
    },
    1
  )

  Write-Utf8Text -Path $Path -Content $updated

  if (Get-Command node -ErrorAction SilentlyContinue) {
    & node --check $Path *> $null
    if ($LASTEXITCODE -ne 0) {
      throw "Runtime syntax check failed after syncing mascot"
    }
  }

  Write-Host ""
  Write-Host "Synced mascot into the live WrapdCode runtime." -ForegroundColor Green
  Write-Host "Runtime: $Path" -ForegroundColor DarkGray
  Write-Host "Backup:  $backupPath" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "Relaunch WrapdCode to see the updated mascot." -ForegroundColor Cyan
}

$art = Get-ClawdArt -Path $SourcePath

switch ($Mode) {
  'preview' { Show-Preview -Art $art -Path $SourcePath }
  'sync' { Sync-RuntimeMascot -Art $art -Path $RuntimePath }
}
