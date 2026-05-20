param(
  [string]$BaseUrl = "http://localhost:4006/api/v1",
  [string]$Email = "admin@dvi.co.in",
  [string]$Password = "Keerthi@2404ias"
)

$ErrorActionPreference = "Stop"

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$resultPath = Join-Path $outDir ("sync-all-india-result-" + $timestamp + ".json")
$metaPath = Join-Path $outDir ("sync-all-india-trigger-" + $timestamp + ".log")

"START=" + (Get-Date -Format o) | Set-Content -Path $metaPath
"BASE_URL=" + $BaseUrl | Add-Content -Path $metaPath

try {
  $loginBody = @{ email = $Email; password = $Password } | ConvertTo-Json
  $login = Invoke-RestMethod -Uri ("$BaseUrl/auth/login") -Method Post -ContentType "application/json" -Body $loginBody

  if (-not $login.accessToken) {
    throw "Login succeeded but no accessToken returned"
  }

  $headers = @{ Authorization = "Bearer $($login.accessToken)" }

  "SYNC_REQUEST_START=" + (Get-Date -Format o) | Add-Content -Path $metaPath
  $response = Invoke-RestMethod -Uri ("$BaseUrl/hotels/sync/all-india") -Method Post -Headers $headers -ContentType "application/json"
  "SYNC_REQUEST_END=" + (Get-Date -Format o) | Add-Content -Path $metaPath

  $response | ConvertTo-Json -Depth 10 | Set-Content -Path $resultPath -Encoding UTF8

  "RESULT_FILE=" + $resultPath | Add-Content -Path $metaPath
  "STATUS=SUCCESS" | Add-Content -Path $metaPath

  Write-Host "Sync completed."
  Write-Host ("Result: " + $resultPath)
  Write-Host ("Log:    " + $metaPath)
}
catch {
  "STATUS=FAILED" | Add-Content -Path $metaPath
  "ERROR=" + $_.Exception.Message | Add-Content -Path $metaPath
  Write-Error $_.Exception.Message
  exit 1
}
