# Runs the router and restarts it 5 seconds after it exits. The Windows scheduled task starts this script.
param([Parameter(Mandatory)][string]$Node)

$main = Join-Path $PSScriptRoot '..\src\main.mjs'
while ($true) {
    & $Node $main
    Start-Sleep -Seconds 5
}
