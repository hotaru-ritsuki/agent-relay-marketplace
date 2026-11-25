$ErrorActionPreference = "Stop"
Add-Type -Path (Join-Path $PSScriptRoot "controller.cs")
[PersistentWindowsJobController]::Run(
  [string]$args[0],
  [string]$args[1],
  [Console]::OpenStandardInput(),
  [Console]::OpenStandardOutput()
)
