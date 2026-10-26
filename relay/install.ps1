# One-step setup on a Windows host with a static public IP and Docker Desktop. Run again after moving to a new host.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Invoke-Docker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "docker $($args -join ' ') failed (exit code $LASTEXITCODE)." }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker is not installed. Install Docker Desktop first: https://docs.docker.com/desktop/setup/install/windows-install/'
}
& docker info *> $null
if ($LASTEXITCODE -ne 0) { throw 'Docker is installed but not running. Start Docker Desktop and run this again.' }

if (-not (Test-Path .env)) {
    $domain = (Read-Host 'Public hostname that points at this host (e.g. relay.example.com)').Trim().ToLower()
    if ($domain -notmatch '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$') { throw 'That does not look like a valid hostname.' }
    Set-Content -Path .env -Value "DOMAIN=$domain" -Encoding ascii
}

Invoke-Docker compose up -d --build

Write-Host ''
Write-Host 'Waiting for the relay to start...'
$healthy = $false
for ($i = 0; $i -lt 30 -and -not $healthy; $i++) {
    & docker compose exec -T relay node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" *> $null
    if ($LASTEXITCODE -eq 0) { $healthy = $true } else { Start-Sleep -Seconds 1 }
}
if (-not $healthy) { throw 'The relay did not become healthy. Check the logs with: docker compose logs relay' }

Write-Host ''
Write-Host 'Egress IP - whitelist this in Dhan (primary or secondary) for every account that uses this relay:'
Invoke-Docker compose exec -T relay node dist/cli.js egress
Write-Host ''
Write-Host 'Create an invite for a phone:  docker compose exec relay node dist/cli.js invite --label "Name"'
Write-Host 'Other commands:                docker compose exec relay node dist/cli.js'
Write-Host ''
Write-Host 'Allow inbound TCP 80 and 443 in Windows Firewall so the phones (and the HTTPS certificate request) can reach this host.'
