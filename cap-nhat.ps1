# Cập nhật app lên GitHub (GitHub Pages + Vercel tự deploy khi đã nối repo).
# Cách dùng (PowerShell, trong G:\Gym):
#   .\cap-nhat.ps1 "Mô tả thay đổi"
param([string]$Message = "Cập nhật app")

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

Write-Host "1/3 Build lại bản web..." -ForegroundColor Cyan
node nhat-ky-tap/build-web.mjs
node coach-platform/mobile/build-web.mjs

Write-Host "2/3 Lưu thay đổi (commit)..." -ForegroundColor Cyan
git add -A
$changes = git status --porcelain
if (-not $changes) { Write-Host "Không có thay đổi nào để cập nhật." -ForegroundColor Yellow; exit 0 }
git commit -m $Message

Write-Host "3/3 Đẩy lên GitHub..." -ForegroundColor Cyan
git push

Write-Host ""
Write-Host "Xong. Vercel (camgym.vercel.app) và GitHub Pages sẽ tự cập nhật sau khoảng 1 phút." -ForegroundColor Green
