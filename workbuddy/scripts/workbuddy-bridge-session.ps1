param(
  [ValidateSet('Start', 'Restore')][string]$Mode = 'Start',
  [string]$Executable,
  [ValidateRange(1, 65535)][int]$Port = 48173
)
$ErrorActionPreference = 'Stop'
$wbRuntimeFile = Join-Path (Get-Location) 'private\workbuddy-bridge\runtime.json'

function Get-OwnedWorkBuddy($Record) {
  if ($Record.schema -ne 1) { throw 'Unknown runtime record schema' }
  $wbProcess = Get-Process -Id $Record.pid -ErrorAction SilentlyContinue
  if (-not $wbProcess) { return $null }
  if ($wbProcess.Path -ne $Record.executable -or $wbProcess.StartTime.ToUniversalTime().ToString('o') -ne $Record.startedAt) {
    throw 'Runtime identity changed; refusing to stop an unrelated process'
  }
  return $wbProcess
}

if ($Mode -eq 'Restore') {
  if (-not (Test-Path -LiteralPath $wbRuntimeFile)) { throw 'No owned runtime record. Exit WorkBuddy normally and launch without debug flags.' }
  $wbRecord = Get-Content -LiteralPath $wbRuntimeFile -Raw | ConvertFrom-Json
  $wbProcess = Get-OwnedWorkBuddy $wbRecord
  if ($wbProcess) {
    # Explicit Restore closes only the process started for this bridge. Finish tasks first.
    Stop-Process -Id $wbProcess.Id
    Wait-Process -Id $wbProcess.Id -Timeout 15 -ErrorAction SilentlyContinue
  }
  if (Get-NetTCPConnection -LocalPort $wbRecord.port -State Listen -ErrorAction SilentlyContinue) { throw 'Debug port still has a listener; normal restore was not confirmed' }
  $wbNormal = Start-Process -FilePath $wbRecord.executable -WindowStyle Hidden -PassThru
  Remove-Item -LiteralPath $wbRuntimeFile
  Write-Output "Normal WorkBuddy launch requested (PID $($wbNormal.Id)); debug port $($wbRecord.port) is closed."
  exit
}

if (-not $Executable) { throw 'Specify -Executable with the installed WorkBuddyAI.exe path' }
$wbExe = (Resolve-Path -LiteralPath $Executable).Path
if ([IO.Path]::GetFileName($wbExe) -ne 'WorkBuddyAI.exe') { throw 'Expected WorkBuddyAI.exe' }
if (Get-Process WorkBuddyAI -ErrorAction SilentlyContinue) { throw 'Exit existing WorkBuddy through its tray menu before starting bridge mode; closing its window may only minimize it.' }
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'Requested debug port is occupied' }
if (Test-Path -LiteralPath $wbRuntimeFile) { throw 'Runtime record already exists; inspect it before starting another bridge instance' }
New-Item -ItemType Directory -Path (Split-Path $wbRuntimeFile) -Force | Out-Null
$wbProcess = Start-Process -FilePath $wbExe -ArgumentList "--remote-debugging-port=$Port", '--remote-debugging-address=127.0.0.1' -WindowStyle Hidden -PassThru
$wbRecord = @{ schema = 1; pid = $wbProcess.Id; executable = $wbExe; startedAt = $wbProcess.StartTime.ToUniversalTime().ToString('o'); port = $Port }
$wbRecord | ConvertTo-Json | Set-Content -LiteralPath $wbRuntimeFile -Encoding utf8
for ($wbAttempt = 0; $wbAttempt -lt 30; $wbAttempt++) {
  try {
    $wbTargets = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/list" -TimeoutSec 1
    if ($wbTargets | Where-Object { $_.type -eq 'page' -and $_.url -match '/app\.asar/renderer/index\.html' }) {
      $wbListeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen)
      if ($wbListeners | Where-Object { $_.LocalAddress -notin @('127.0.0.1', '::1') -or $_.OwningProcess -ne $wbProcess.Id }) { throw 'Unexpected listener address or owner' }
      Write-Output "WorkBuddy bridge ready at 127.0.0.1:$Port. Run node scripts/dispatch-workbuddy.mjs --status."
      exit
    }
  } catch { if ($_.Exception.Message -eq 'Unexpected listener address or owner') { throw } }
  Start-Sleep -Seconds 1
}
throw 'WorkBuddy bridge did not become ready within 30 seconds. Run -Mode Restore to close this owned instance and restore normal launch.'
