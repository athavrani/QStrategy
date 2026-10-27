$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

# Settings come from .env (KEY=value per line); anything already set in the environment wins.
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$' -and -not [Environment]::GetEnvironmentVariable($Matches[1])) {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'))
        }
    }
}

# Only Caddy (HTTPS) is exposed to the internet; the relay itself listens on this machine only.
if (-not $env:HOST) { $env:HOST = '127.0.0.1' }
if (-not $env:TRUST_PROXY) { $env:TRUST_PROXY = 'true' }
if (-not $env:DB_PATH) { $env:DB_PATH = Join-Path $PSScriptRoot 'data\relay.db' }

& node dist\index.js
exit $LASTEXITCODE
