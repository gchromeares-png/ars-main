param(
  [Parameter(Mandatory=$true)][string]$OutputDir,
  [int]$IntervalSeconds = 2
)

$ErrorActionPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$out = Join-Path $OutputDir 'pid-ownership.jsonl'

function Snapshot-Tree {
  $all = Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate
  $interesting = $all | Where-Object {
    $_.Name -match 'electron|node|python|chrome' -or
    ($_.CommandLine -and ($_.CommandLine -match 'worker\.js|task_browser_worker_oopif\.py|seleniumbase|ares-windows-ui-runtime'))
  }

  $records = foreach ($p in $interesting) {
    $parent = $all | Where-Object { $_.ProcessId -eq $p.ParentProcessId } | Select-Object -First 1
    [ordered]@{
      ts = (Get-Date).ToUniversalTime().ToString('o')
      pid = [int]$p.ProcessId
      ppid = [int]$p.ParentProcessId
      name = [string]$p.Name
      commandLine = [string]$p.CommandLine
      parentName = if ($parent) { [string]$parent.Name } else { '' }
      parentCommandLine = if ($parent) { [string]$parent.CommandLine } else { '' }
      role = if ($p.CommandLine -match 'worker\.js') { 'node-browser-worker' }
             elseif ($p.CommandLine -match 'task_browser_worker_oopif\.py') { 'python-oopif-worker' }
             elseif ($p.Name -match '^chrome') { 'chrome' }
             elseif ($p.Name -match '^electron') { 'electron' }
             elseif ($p.Name -match '^node') { 'node' }
             elseif ($p.Name -match '^python') { 'python' }
             else { 'other' }
    }
  }

  $payload = [ordered]@{
    ts = (Get-Date).ToUniversalTime().ToString('o')
    records = @($records)
  }
  ($payload | ConvertTo-Json -Compress -Depth 6) | Add-Content -Path $out -Encoding utf8
}

while ($true) {
  Snapshot-Tree
  Start-Sleep -Seconds $IntervalSeconds
}
