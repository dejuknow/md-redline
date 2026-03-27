param(
    [switch]$Headed,
    [switch]$UI,
    [switch]$InstallOnly,
    [string]$ProjectRoot = $PSScriptRoot + "\.."
)

# Move to project root
Push-Location $ProjectRoot

Write-Host "`n--- md-redline Windows Test Runner ---" -ForegroundColor Cyan

# 1. Check for Node.js
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Node.js is not installed. Please install it from https://nodejs.org/" -ForegroundColor Red
    Pop-Location
    exit 1
}

# 2. Install dependencies if node_modules is missing
if (!(Test-Path "node_modules")) {
    Write-Host "node_modules not found. Installing dependencies..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) { 
        Write-Host "npm install failed." -ForegroundColor Red
        Pop-Location
        exit $LASTEXITCODE 
    }
}

# 3. Ensure Playwright browsers are installed
Write-Host "Checking Playwright browsers..." -ForegroundColor Yellow
npx playwright install chromium --with-deps
if ($LASTEXITCODE -ne 0) { 
    Write-Host "Playwright installation failed." -ForegroundColor Red
    Pop-Location
    exit $LASTEXITCODE 
}

if ($InstallOnly) {
    Write-Host "Setup complete! Browsers and dependencies are ready." -ForegroundColor Green
    Pop-Location
    exit 0
}

# 4. Determine command arguments
$playwrightArgs = @("test")
if ($Headed) { 
    $playwrightArgs += "--headed" 
    Write-Host "Running in HEADED mode..." -ForegroundColor Cyan
}
if ($UI) { 
    $playwrightArgs += "--ui" 
    Write-Host "Opening Playwright UI..." -ForegroundColor Cyan
}

# 5. Run the tests
Write-Host "Starting tests...`n" -ForegroundColor Green
npx playwright $playwrightArgs

$exitCode = $LASTEXITCODE
Pop-Location

if ($exitCode -eq 0) {
    Write-Host "`nTests passed successfully!" -ForegroundColor Green
} else {
    Write-Host "`nTests failed with exit code $exitCode" -ForegroundColor Red
}

exit $exitCode
