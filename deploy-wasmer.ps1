param(
    [switch]$Deploy
)

$ErrorActionPreference = "Stop"

function Fail($message) {
    Write-Error $message
    exit 1
}

if (-not (Get-Command wasmer -ErrorAction SilentlyContinue)) {
    Fail "Wasmer CLI is not installed. Install it, then run this script again."
}

Write-Host "Wasmer CLI found." -ForegroundColor Green
wasmer --version

Write-Host ""
Write-Host "Next step: authenticate if needed." -ForegroundColor Yellow
Write-Host "Command: wasmer login"

if ($Deploy) {
    Write-Host ""
    Write-Host "Deploying app..." -ForegroundColor Yellow
    wasmer deploy
    if ($LASTEXITCODE -ne 0) {
        Fail "wasmer deploy failed."
    }

    Write-Host ""
    Write-Host "Deployment finished." -ForegroundColor Green
    Write-Host "Verify backend endpoint:"
    Write-Host "  https://<your-domain>/api/health"
    Write-Host "Expected JSON: {`"ok`":true}"
}
