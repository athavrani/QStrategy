<#
.SYNOPSIS
    Automated Release Script for QStrategy (Mobile Terminal)
.DESCRIPTION
    1. Inspects current version from app.json
    2. Runs automated tests and typecheck
    3. Bumps version and Android versionCode in app.json and package.json
    4. Compiles standalone release APK (assembleRelease) with offline Hermes bundle
    5. Copies APK to project root (QStrategy.apk)
    6. Creates git commit and version tag (vX.Y.Z)
    7. Pushes commits and tags to GitHub
    8. Automatically creates GitHub Release and uploads APK (if GITHUB_TOKEN provided)
       OR opens GitHub release page in browser with pre-filled details.
.EXAMPLE
    .\scripts\release.ps1
    .\scripts\release.ps1 -Bump patch -Notes "Fix option chain feed latency"
    .\scripts\release.ps1 -Version 1.0.1 -Notes "Sensex 09:20 OOBTST improvements"
    npm run release
#>

[CmdletBinding()]
param (
    [Parameter(Mandatory = $false)]
    [string]$Version,

    [Parameter(Mandatory = $false)]
    [ValidateSet("patch", "minor", "major")]
    [string]$Bump = "patch",

    [Parameter(Mandatory = $false)]
    [string]$Notes,

    [Parameter(Mandatory = $false)]
    [switch]$SkipTests,

    [Parameter(Mandatory = $false)]
    [switch]$SkipBuild,

    [Parameter(Mandatory = $false)]
    [switch]$NoPush,

    [Parameter(Mandatory = $false)]
    [string]$GitHubToken
)

$ErrorActionPreference = "Stop"

# Resolve project root
if (Test-Path "$PSScriptRoot\..\app.json") {
    $ProjectRoot = (Resolve-Path "$PSScriptRoot\..").Path
} elseif (Test-Path "$PSScriptRoot\app.json") {
    $ProjectRoot = (Resolve-Path "$PSScriptRoot").Path
} else {
    $ProjectRoot = (Get-Location).Path
}
Set-Location $ProjectRoot

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "       [QSTRATEGY] AUTOMATED MOBILE RELEASE TERMINAL        " -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ("Workspace: {0}" -f $ProjectRoot) -ForegroundColor DarkGray

# Ensure JDK and Android SDK paths
if (-not $env:JAVA_HOME -or -not (Test-Path $env:JAVA_HOME)) {
    if (Test-Path "C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot") {
        $env:JAVA_HOME = "C:\Program Files\Microsoft\jdk-17.0.20.101-hotspot"
    }
}
if (-not $env:ANDROID_HOME -or -not (Test-Path $env:ANDROID_HOME)) {
    if (Test-Path "C:\Android\Sdk") {
        $env:ANDROID_HOME = "C:\Android\Sdk"
    }
}
$env:Path = "$($env:JAVA_HOME)\bin;$($env:ANDROID_HOME)\platform-tools;$($env:Path)"

# 1. Get Current Version Info
$verJson = node scripts/version-tool.js get
$currentVerObj = $verJson | ConvertFrom-Json
$CurrentVer = $currentVerObj.version
$CurrentCode = $currentVerObj.versionCode

Write-Host ("Current Installed Version: v{0} (Build {1})" -f $CurrentVer, $CurrentCode) -ForegroundColor Yellow

# Calculate proposed version
$targetVer = ""
if ($Version) {
    $targetVer = $Version.Trim().TrimStart("v")
} else {
    $vParts = $CurrentVer.Split('.')
    $maj = [int]$vParts[0]
    $min = if ($vParts.Length -gt 1) { [int]$vParts[1] } else { 0 }
    $pat = if ($vParts.Length -gt 2) { [int]$vParts[2] } else { 0 }

    if ($Bump -eq "major") {
        $maj++
        $min = 0
        $pat = 0
    } elseif ($Bump -eq "minor") {
        $min++
        $pat = 0
    } else {
        $pat++
    }
    $targetVer = ("{0}.{1}.{2}" -f $maj, $min, $pat)
}
$targetCode = [int]$CurrentCode + 1

# Prompt for Release Notes if not passed via param
if (-not $Notes) {
    Write-Host ""
    Write-Host ("Enter release notes for v{0} (or press Enter for default):" -f $targetVer) -ForegroundColor White
    $inputNotes = Read-Host "Notes"
    if ($inputNotes -and $inputNotes.Trim().Length -gt 0) {
        $Notes = $inputNotes.Trim()
    } else {
        $Notes = ("Release v{0}: Algorithmic strategy optimizations and performance enhancements." -f $targetVer)
    }
}

Write-Host ""
Write-Host ("Target Release Version:   v{0} (Build {1})" -f $targetVer, $targetCode) -ForegroundColor Green
Write-Host ("Release Notes:            {0}" -f $Notes) -ForegroundColor Green
Write-Host ""

# 2. Run Pre-flight Checks (TypeScript Typecheck & Jest Unit Tests)
if (-not $SkipTests) {
    Write-Host "-> Running Typecheck (npm run typecheck)..." -ForegroundColor Cyan
    npm run typecheck
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Typecheck failed! Aborting release." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] Typecheck passed!" -ForegroundColor Green

    Write-Host "-> Running Automated Unit Tests (npm test)..." -ForegroundColor Cyan
    npm test
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[ERROR] Unit tests failed! Aborting release." -ForegroundColor Red
        exit 1
    }
    Write-Host "[OK] All unit tests passed!" -ForegroundColor Green
} else {
    Write-Host "[WARN] Skipping tests (-SkipTests)" -ForegroundColor Yellow
}

# 3. Apply Version Bump to Manifests
Write-Host ""
Write-Host ("-> Updating app.json and package.json to v{0} (Build {1})..." -f $targetVer, $targetCode) -ForegroundColor Cyan
if ($Version) {
    $bumpResult = node scripts/version-tool.js set $targetVer $Notes
} else {
    $bumpResult = node scripts/version-tool.js bump $Bump $Notes
}
Write-Host "[OK] Manifests updated successfully." -ForegroundColor Green

# 4. Compile Standalone Android Release APK
if (-not $SkipBuild) {
    Write-Host ""
    Write-Host "-> Compiling Standalone Release APK with Gradle (assembleRelease)..." -ForegroundColor Cyan
    Write-Host "   (Embedding Hermes bytecode and offline JavaScript bundle)" -ForegroundColor DarkGray

    Push-Location "android"
    try {
        .\gradlew.bat assembleRelease
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[ERROR] Gradle compilation failed!" -ForegroundColor Red
            Pop-Location
            exit 1
        }
    } finally {
        Pop-Location
    }

    $sourceApk = "android\app\build\outputs\apk\release\app-release.apk"
    $targetApk = "QStrategy.apk"

    if (Test-Path $sourceApk) {
        Copy-Item -Path $sourceApk -Destination $targetApk -Force
        $apkItem = Get-Item $targetApk
        $apkSizeMb = [math]::Round($apkItem.Length / 1MB, 2)
        Write-Host ("Standlone APK ready: {0} ({1} MB)" -f $targetApk, $apkSizeMb) -ForegroundColor Green
    } else {
        Write-Host ("Could not find compiled APK at {0}" -f $sourceApk) -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[WARN] Skipping APK build (-SkipBuild)" -ForegroundColor Yellow
}

# 5. Git Commit & Version Tagging
Write-Host ""
Write-Host ("-> Creating Git commit and version tag 'v{0}'..." -f $targetVer) -ForegroundColor Cyan

git add -A

$commitMsg = ("release: v{0}" -f $targetVer)
git commit -m $commitMsg
Write-Host ("Git commit created: '{0}'" -f $commitMsg) -ForegroundColor Green

$existingTag = git tag -l ("v{0}" -f $targetVer)
if ($existingTag) {
    Write-Host ("Tag 'v{0}' already exists locally. Updating tag..." -f $targetVer) -ForegroundColor Yellow
    git tag -d ("v{0}" -f $targetVer)
}
git tag -a ("v{0}" -f $targetVer) -m ("Release v{0}: {1}" -f $targetVer, $Notes)
Write-Host ("Git tag 'v{0}' created." -f $targetVer) -ForegroundColor Green

# 6. Push to GitHub
if (-not $NoPush) {
    Write-Host ""
    Write-Host "-> Pushing commits and tags to GitHub (origin main)..." -ForegroundColor Cyan
    git push origin main
    git push origin ("v{0}" -f $targetVer) --force
    Write-Host "[OK] Pushed to GitHub successfully!" -ForegroundColor Green
} else {
    Write-Host "[WARN] Skipping git push (-NoPush)" -ForegroundColor Yellow
}

# 7. Create GitHub Release & Upload APK
Write-Host ""
Write-Host "-> Publishing Release to GitHub..." -ForegroundColor Cyan

$token = if ($GitHubToken) { $GitHubToken } elseif ($env:GITHUB_TOKEN) { $env:GITHUB_TOKEN } elseif ($env:GH_TOKEN) { $env:GH_TOKEN } else {
    try {
        $credLines = "protocol=https`nhost=github.com`n" | git credential fill 2>$null
        $pwdLine = $credLines | Where-Object { $_ -match "^password=" }
        if ($pwdLine) { ($pwdLine -replace "^password=", "").Trim() } else { $null }
    } catch { $null }
}

if ($token) {
    Write-Host "Authenticating with GitHub credentials..." -ForegroundColor DarkGray
    try {
        $releasePayload = @{
            tag_name         = ("v{0}" -f $targetVer)
            name             = ("QStrategy v{0}" -f $targetVer)
            body             = $Notes
            draft            = $false
            prerelease       = $false
        } | ConvertTo-Json

        $headers = @{
            "Authorization" = ("Bearer {0}" -f $token)
            "Accept"        = "application/vnd.github+json"
            "User-Agent"    = "QStrategy-Release"
        }

        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/athavrani/QStrategy/releases" -Method Post -Headers $headers -Body $releasePayload
        Write-Host ("GitHub Release created: {0}" -f $release.html_url) -ForegroundColor Green

        if (Test-Path "QStrategy.apk") {
            Write-Host "-> Uploading QStrategy.apk asset to GitHub Release..." -ForegroundColor Cyan
            $uploadUri = $release.upload_url -replace '\{\?name,label\}', "?name=QStrategy.apk"
            
            & curl.exe -s -X POST -H ("Authorization: Bearer {0}" -f $token) -H "Content-Type: application/vnd.android.package-archive" --data-binary "@QStrategy.apk" $uploadUri
            Write-Host "[OK] QStrategy.apk successfully attached to release!" -ForegroundColor Green
        }
    } catch {
        Write-Host ("GitHub API upload failed: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
        $webUrl = "https://github.com/athavrani/QStrategy/releases/new?tag=v" + $targetVer + "&title=QStrategy+v" + $targetVer
        Start-Process $webUrl
    }
} else {
    Write-Host "Opening GitHub Release creation page in browser with tag pre-filled..." -ForegroundColor White
    $encodedNotes = [uri]::EscapeDataString($Notes)
    $webUrl = "https://github.com/athavrani/QStrategy/releases/new?tag=v" + $targetVer + "&title=QStrategy+v" + $targetVer + "&body=" + $encodedNotes
    Start-Process $webUrl

    Write-Host ""
    Write-Host "Next Step to finish in 10 seconds:" -ForegroundColor Cyan
    Write-Host "   1. Browser opened to GitHub Releases." -ForegroundColor White
    Write-Host "   2. Drag and drop 'c:\Project\QStrategy\QStrategy.apk' into the release asset box." -ForegroundColor White
    Write-Host "   3. Click 'Publish release'." -ForegroundColor White
}

# 8. Summary
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host ("           RELEASE v{0} COMPLETED!                 " -f $targetVer) -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ("Version:       v{0} (Build {1})" -f $targetVer, $targetCode)
Write-Host ("APK File:      {0}\QStrategy.apk" -f $ProjectRoot)
Write-Host ("Git Tag:       v{0}" -f $targetVer)
Write-Host "Auto-Update:   Live! Installed mobile apps will receive this update."
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
