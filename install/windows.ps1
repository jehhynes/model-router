# Registers the model-router scheduled task, which starts at logon without a window and restarts the router when it exits.
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$name = 'model-router'
$root = Split-Path $PSScriptRoot

function Remove-Task {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $name -ErrorAction Stop
        Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction Stop
    }
}

if ($Uninstall) {
    Remove-Task
    return
}

if (-not (Test-Path (Join-Path $root '.env'))) {
    throw "Create $root\.env from .env.example first."
}
$ports = @((Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json).listeners.port)
if ($ports.Count -eq 0) {
    throw "config.json has no listeners."
}
$node = (Get-Command node).Source
$pwsh = (Get-Command pwsh).Source
$run = Join-Path $PSScriptRoot 'run.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -NonInteractive -File `"$run`" -Node `"$node`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
# S4U runs the task without a window and without storing a password; the account needs "Log on as a batch job".
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)

Remove-Task
$busy = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in $ports)
if ($busy) {
    throw "Ports $($busy.LocalPort -join ', ') are in use by process $($busy.OwningProcess -join ', '); stop it and run this again."
}
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -ErrorAction Stop | Out-Null
Start-ScheduledTask -TaskName $name -ErrorAction Stop

$deadline = (Get-Date).AddSeconds(15)
while ((Get-Date) -lt $deadline) {
    $listening = @($ports | Where-Object { Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $_ -State Listen -ErrorAction SilentlyContinue })
    if ($listening.Count -eq $ports.Count) {
        Write-Output "Registered the $name scheduled task; it is listening on $($ports -join ', ')."
        return
    }
    Start-Sleep -Milliseconds 500
}
throw "The $name task started, but the router is not listening on $($ports -join ', '). See the log file named in config.json."
