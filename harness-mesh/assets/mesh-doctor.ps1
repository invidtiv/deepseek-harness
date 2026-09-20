<#
.SYNOPSIS
  Mesh cross-machine preflight.

.DESCRIPTION
  Answers, per node: is the node in 'tailscale status'; does the recorded address
  still match; is the runtime new enough; is the mesh port bound only to loopback
  or a Tailscale address; and, once per machine, is any mesh port Funnel-exposed
  to the public internet (it must never be).

  Remote checks run over SSH and report as skipped, with the reason, when SSH is
  not usable. Every row carries a remediation line. The script exits 1 if any
  non-skipped row is red.

.PARAMETER NodesFile
  Path to nodes.json. Defaults to the copy beside this script.

.PARAMETER Only
  Restrict the run to one node key, for example -Only L.

.EXAMPLE
  pwsh ./mesh-doctor.ps1
  pwsh ./mesh-doctor.ps1 -Only L
#>
[CmdletBinding()]
param(
  [string] $NodesFile = (Join-Path $PSScriptRoot 'nodes.json'),
  [string] $Only
)

$ErrorActionPreference = 'Stop'

function New-Row {
  param([string] $Node, [string] $Check, [bool] $Ok, [string] $Detail, [string] $Fix, [bool] $Skipped = $false)
  [pscustomobject]@{ Node = $Node; Check = $Check; Ok = $Ok; Skipped = $Skipped; Detail = $Detail; Fix = $Fix }
}

function Get-TailscaleStatus {
  $raw = & tailscale status --json 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  return $raw | ConvertFrom-Json
}

# Loopback, the tailnet CGNAT range 100.64.0.0/10, or the Tailscale IPv6 range.
function Test-TailscaleBind {
  param([string] $Address)
  return [bool]($Address -match '^(127\.0\.0\.1|\[::1\]|\[?fd7a:115c:a1e0:|100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\.)')
}

function Invoke-Remote {
  param([string] $Ssh, [string] $Command)
  $output = (& ssh -o BatchMode=yes -o ConnectTimeout=6 $Ssh $Command 2>&1 | Out-String).Trim()
  return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Out = $output }
}

function Get-NodeChecks {
  param([string] $Name, $Node)

  $rows = @()
  $bindFix = 'T1 binds a unix socket; T2 binds 127.0.0.1; T3 binds this node Tailscale address. Never 0.0.0.0 or a LAN address.'

  if ($Node.ssh) {
    $probe = Invoke-Remote $Node.ssh 'echo mesh-doctor-ok; node --version; pnpm --version'
    $sshOk = $probe.Ok -and ($probe.Out -match 'mesh-doctor-ok')
    $rows += New-Row $Name 'ssh' $sshOk $probe.Out 'add a Host entry for this alias to ~/.ssh/config, then authorize this machine public key'
    if (-not $sshOk) {
      $rows += New-Row $Name 'remote-runtime' $true 'skipped: no ssh access' '' $true
      $rows += New-Row $Name 'mesh-bind-address' $true 'skipped: no ssh access' '' $true
      return $rows
    }
    $runtimeOk = [bool]($probe.Out -match 'v(2[2-9]|[3-9][0-9])\.')
    $rows += New-Row $Name 'remote-runtime' $runtimeOk $probe.Out 'install Node ^22.19 || >=24 and pnpm on the node'
  }
  else {
    $localNode = ((& node --version 2>&1) -join ' ').Trim()
    $runtimeOk = [bool]($localNode -match 'v(2[2-9]|[3-9][0-9])\.')
    $rows += New-Row $Name 'local-runtime' $runtimeOk "node $localNode" 'install Node ^22.19 || >=24'
  }

  # The bind target is a discriminated union, so each topology is checked as itself.
  $kind = $Node.listen.kind
  if ($kind -eq 'unix') {
    $path = $Node.listen.path
    if ($Node.ssh) {
      $r = Invoke-Remote $Node.ssh ("test -S '" + $path + "' && echo socket || echo none")
      $present = ($r.Ok -and ($r.Out.Trim() -eq 'socket'))
      if (-not $r.Ok) { $rows += New-Row $Name 'mesh-bind-address' $true 'skipped: no ssh access' '' $true; return $rows }
    }
    else {
      $present = Test-Path $path
    }
    $detail = 'no unix socket yet (the listener is opt-in)'
    if ($present) { $detail = 'unix socket present at ' + $path }
    $rows += New-Row $Name 'mesh-bind-address' $true $detail $bindFix
    return $rows
  }

  $port = [int] $Node.listen.port
  if ($Node.ssh) {
    $listeners = Invoke-Remote $Node.ssh ("ss -ltn 2>/dev/null | awk 'NR>1 {print `$4}' | grep ':" + $port + "`$' || true")
    $bindings = @()
    if ($listeners.Ok -and $listeners.Out) { $bindings = @($listeners.Out -split '\s+' | Where-Object { $_ }) }
  }
  else {
    $conns = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $port })
    $bindings = @($conns | ForEach-Object { "$($_.LocalAddress):$($_.LocalPort)" })
  }

  $detail = 'no listener on port ' + $port + ' (the listener is opt-in)'
  if ($bindings.Count -gt 0) { $detail = "bound on: $($bindings -join ', ')" }
  $bad = @($bindings | Where-Object { -not (Test-TailscaleBind $_) })
  $rows += New-Row $Name 'mesh-bind-address' ($bad.Count -eq 0) $detail $bindFix

  return $rows
}

function Get-FunnelRows {
  param($Config, [string[]] $ServeLines)

  $ports = @()
  foreach ($p in $Config.nodes.PSObject.Properties) {
    if ($p.Value.pending) { continue }
    if ($p.Value.published.port) { $ports += [int]$p.Value.published.port }
  }
  $ports = @($ports | Sort-Object -Unique)

  # The summary block lists funnel endpoints as '#     - tcp://host:port'.
  $funnelEndpoints = @()
  foreach ($line in $ServeLines) {
    if ($line -match '^#\s+-\s+(\S+)\s*$') { $funnelEndpoints += $Matches[1] }
  }

  $exposed = @()
  foreach ($endpoint in $funnelEndpoints) {
    foreach ($port in $ports) {
      if ($endpoint -match ":$port\$") { $exposed += "$endpoint (mesh port $port)" }
    }
  }

  $detail = "no Funnel listener covers the mesh ports ($($ports -join ', '))"
  if ($funnelEndpoints.Count -eq 0) { $detail = 'no Funnel listener is configured on this machine' }
  if ($funnelEndpoints.Count -gt 0 -and $exposed.Count -eq 0) { $detail = "Funnel is on for $($funnelEndpoints -join ', '), none of which is a mesh port" }
  if ($exposed.Count -gt 0) { $detail = "Funnel-exposed: $($exposed -join ' | ')" }

  return @(New-Row 'machine' 'not-funnel-exposed' ($exposed.Count -eq 0) $detail 'tailscale funnel --https=<publishedPort> off')
}

# ---- run -------------------------------------------------------------------

if (-not (Test-Path $NodesFile)) { throw "nodes file not found: $NodesFile" }

$config = Get-Content $NodesFile -Raw | ConvertFrom-Json
$status = Get-TailscaleStatus
$serveText = (& tailscale serve status 2>&1 | Out-String)
$serveLines = @($serveText -split "\r?\n")

$all = @()
foreach ($property in $config.nodes.PSObject.Properties) {
  if ($Only -and $property.Name -ne $Only) { continue }
  $node = $property.Value
  $name = $property.Name

  if ($node.pending) {
    $reason = 'descriptor marked pending'
    if ($node.pendingReason) { $reason = $node.pendingReason }
    $all += New-Row $name 'device-present' $false $reason 'add the machine to the tailnet, then clear pending in nodes.json'
    continue
  }

  $fqdn = "$($node.tailscaleName)."
  $peer = $null
  if ($status) {
    $peer = $status.Peer.PSObject.Properties.Value | Where-Object { $_.DNSName -eq $fqdn } | Select-Object -First 1
    if (-not $peer -and $status.Self.DNSName -eq $fqdn) { $peer = $status.Self }
  }
  $detail = 'not present in tailscale status'
  if ($peer) { $detail = "DNSName=$($peer.DNSName) ips=$($peer.TailscaleIPs -join ',') online=$($peer.Online)" }
  $all += New-Row $name 'tailscale-peer' ([bool]$peer) $detail 'bring the machine onto this tailnet'

  if ($peer) {
    $ips = @($peer.TailscaleIPs)
    $match = [bool]($node.ip -and ($ips -contains $node.ip))
    $all += New-Row $name 'address-current' $match "recorded=$($node.ip) tailnet=$($ips -join ',')" 'update nodes.json from tailscale status --json'
  }

  $all += Get-NodeChecks -Name $name -Node $node
}

$all += Get-FunnelRows -Config $config -ServeLines $serveLines

$all | Format-Table -AutoSize -Wrap

$failures = @($all | Where-Object { -not $_.Ok -and -not $_.Skipped })
$skipped = @($all | Where-Object { $_.Skipped })

Write-Host ''
if ($skipped.Count -gt 0) {
  Write-Host "$($skipped.Count) check(s) skipped:" -ForegroundColor Yellow
  foreach ($row in $skipped) { Write-Host "  [$($row.Node)] $($row.Check): $($row.Detail)" -ForegroundColor Yellow }
}
if ($failures.Count -gt 0) {
  Write-Host "$($failures.Count) check(s) failed:" -ForegroundColor Red
  foreach ($failure in $failures) {
    Write-Host "  [$($failure.Node)] $($failure.Check): $($failure.Detail)" -ForegroundColor Red
    if ($failure.Fix) { Write-Host "      fix: $($failure.Fix)" -ForegroundColor Yellow }
  }
  exit 1
}
Write-Host 'no non-skipped check failed' -ForegroundColor Green
exit 0
