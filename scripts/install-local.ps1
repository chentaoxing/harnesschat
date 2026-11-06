# Local install helper: copy dist/win-unpacked over the per-user install dir and relaunch.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-local.ps1
$ErrorActionPreference = 'Stop'
# The repo path contains a non-ASCII category folder. Do not hardcode it:
# PS 5.1 reads BOM-less .ps1 as ANSI and would mangle the literal. Resolve by wildcard.
$src = (Resolve-Path 'E:\Agent\Date\ZCode\workspace\*\agent-group\dist\win-unpacked' | Select-Object -First 1).Path
$dst = Join-Path $env:LOCALAPPDATA 'Programs\HarnessChat'
Write-Output "SRC=$src"
Write-Output "SRC_EXISTS=$(Test-Path $src)"
Write-Output "DST_EXISTS=$(Test-Path $dst)"
$procs = Get-CimInstance Win32_Process -Filter "Name='HarnessChat.exe'" | Where-Object { $_.ExecutablePath -like "$dst*" }
Write-Output "RUNNING_BEFORE=$($procs.Count)"
foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2
$still = Get-CimInstance Win32_Process -Filter "Name='HarnessChat.exe'" | Where-Object { $_.ExecutablePath -like "$dst*" }
Write-Output "RUNNING_AFTER_KILL=$($still.Count)"
if ($still.Count -gt 0) { Write-Output 'INSTALL_ABORTED_STILL_RUNNING'; exit 1 }
Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force
$exe = Join-Path $dst 'HarnessChat.exe'
Write-Output "EXE_SIZE=$((Get-Item $exe).Length)"
$asar = Join-Path $dst 'resources\app.asar'
Write-Output "ASAR_MTIME=$((Get-Item $asar).LastWriteTime.ToString('s'))"
Start-Process -FilePath $exe
Start-Sleep -Seconds 6
$now = Get-CimInstance Win32_Process -Filter "Name='HarnessChat.exe'" | Where-Object { $_.ExecutablePath -like "$dst*" }
Write-Output "RUNNING_NOW=$($now.Count)"
Write-Output 'INSTALL_LOCAL_DONE'