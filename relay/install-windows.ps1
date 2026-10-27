# Installs the relay on a Windows host WITHOUT Docker. Run in PowerShell as Administrator.
# It builds the relay, adds HTTPS with Caddy, and starts both automatically at boot. Run again after an update.
[CmdletBinding()]
param([string]$Domain)

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Assert-Ok($what) {
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit code $LASTEXITCODE)." }
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw 'Run this in PowerShell as Administrator (right-click PowerShell, Run as administrator).' }

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'Node.js is not installed. Install the LTS version from https://nodejs.org, open a new Administrator PowerShell, and run this again.' }
$nodeMajor = [int]((& node -v).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js 20 or newer is required (found $(& node -v)). Install the current LTS from https://nodejs.org." }

if (-not $Domain) {
    $Domain = (Read-Host 'Public hostname that points at this machine (e.g. relay.example.com)').Trim().ToLower()
}
if ($Domain -notmatch '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$') { throw 'That does not look like a valid hostname.' }

Write-Host 'Installing and building the relay...'
# npm.cmd, not npm: the npm.ps1 shim mishandles `ci` on some installs.
& npm.cmd ci
Assert-Ok 'npm ci'
& npm.cmd run build
Assert-Ok 'npm run build'

$caddy = Join-Path $PSScriptRoot 'bin\caddy.exe'
if (-not (Test-Path $caddy)) {
    Write-Host 'Downloading Caddy (HTTPS front end)...'
    New-Item -ItemType Directory -Force -Path (Split-Path $caddy) | Out-Null
    Invoke-WebRequest 'https://caddyserver.com/api/download?os=windows&arch=amd64' -OutFile $caddy -UseBasicParsing
}

$caddyfile = Join-Path $PSScriptRoot 'Caddyfile.windows'
Set-Content -Path $caddyfile -Encoding ascii -Value "$Domain {`n`treverse_proxy 127.0.0.1:8787`n}"

if (-not (Get-NetFirewallRule -DisplayName 'QStrategy relay HTTP/HTTPS' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName 'QStrategy relay HTTP/HTTPS' -Direction Inbound -Protocol TCP -LocalPort 80, 443 -Action Allow | Out-Null
}

function Register-Startup($name, $exe, $arguments) {
    Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
    $action = New-ScheduledTaskAction -Execute $exe -Argument $arguments -WorkingDirectory $PSScriptRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings | Out-Null
    Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName $name
}

Register-Startup 'QStrategyRelay' 'powershell.exe' "-NoProfile -ExecutionPolicy Bypass -File `"$PSScriptRoot\run-relay.ps1`""
Register-Startup 'QStrategyCaddy' $caddy "run --config `"$caddyfile`" --adapter caddyfile"

Write-Host 'Waiting for the relay to start...'
$healthy = $false
for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
    try { $healthy = (Invoke-WebRequest 'http://127.0.0.1:8787/healthz' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { Start-Sleep -Seconds 1 }
}
if (-not $healthy) { throw 'The relay did not start. Run .\run-relay.ps1 in this window to see the error.' }

Write-Host ''
Write-Host 'Relay is running and will start automatically after a reboot.' -ForegroundColor Green
Write-Host 'Egress IP - whitelist this in Dhan for every account that uses this relay:'
& node dist\cli.js egress
Write-Host ''
Write-Host "Check HTTPS (after DNS points $Domain here):  https://$Domain/healthz"
Write-Host 'Create an invite for a phone:                 node dist\cli.js invite --label "Name"'
Write-Host 'Other commands:                               node dist\cli.js'
