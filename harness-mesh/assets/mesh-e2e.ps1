<#
.SYNOPSIS
  Mesh cross-machine suite driver.

.DESCRIPTION
  Runs the mesh validation tiers against the nodes described in nodes.json.
  Every probe target - scheme, host, port, path, topology - is derived from the
  descriptor, never hardcoded, so a node on a different published port or path
  is tested correctly.

  Suites:
    preflight  the doctor plus per-node reachability            (runs today)
    network    architecture invariants that need no mesh code   (partially runnable today)
    pairing    E-PAIR-*         requires the mesh packages
    presence   E-PRES-*         requires the mesh packages
    reads      E-READ-*, E-STREAM-*
    writes     E-WRITE-*, E-DENY-*, E-BUDGET-*
    ops        E-OPS-*, E-NET-*, E-LOOP-*
    all        every suite above

  A case whose precondition is absent is reported as SKIPPED with the reason and
  is never reported as passed. In particular, a refused connection to a port
  where nothing is listening proves nothing and is a skip, not a pass.

.PARAMETER NodesFile
  Path to nodes.json.

.PARAMETER Suite
  Which suite to run. Default all.

.PARAMETER Case
  Run only the cases whose id matches this pattern, for example -Case 'E-ARCH-*'.

.PARAMETER KeepRunning
  Do not tear down remote processes started by a suite. No suite starts a remote
  process yet, so passing this currently produces a warning and no effect.

.EXAMPLE
  pwsh ./mesh-e2e.ps1 -Suite network
  pwsh ./mesh-e2e.ps1 -Suite all -Case 'E-ARCH-01'
#>
[CmdletBinding()]
param(
  [string] $NodesFile = (Join-Path $PSScriptRoot 'nodes.json'),
  [string] $Suite = 'all',
  [string] $Case = '*',
  [switch] $KeepRunning
)

$ErrorActionPreference = 'Stop'

# The engine range the repository declares in package.json.
$ENGINE_RANGE = '^22.19 || >=24'

$script:Results = @()

function Add-Result {
  param([string] $Id, [string] $Outcome, [string] $Detail)
  $script:Results += [pscustomobject]@{ Case = $Id; Outcome = $Outcome; Detail = $Detail }
  $colour = 'Gray'
  if ($Outcome -eq 'pass') { $colour = 'Green' }
  if ($Outcome -eq 'fail') { $colour = 'Red' }
  if ($Outcome -eq 'skip') { $colour = 'Yellow' }
  Write-Host ("{0,-14} {1,-6} {2}" -f $Id, $Outcome, $Detail) -ForegroundColor $colour
}

function Test-CaseWanted {
  param([string] $Id)
  return $Id -like $Case
}

# Parse the supported engine range instead of approximating it with a regex.
# '^22.19' means major 22 with minor >= 19; '>=24' means major >= 24.
function Test-EngineRange {
  param([string] $Version, [string] $Range = $ENGINE_RANGE)
  if (-not $Version) { return $false }
  $clean = $Version.Trim()
  if ($clean.StartsWith('v') -or $clean.StartsWith('V')) { $clean = $clean.Substring(1) }
  $parts = $clean -split '[.\-+]'
  if ($parts.Count -lt 2) { return $false }
  $major = 0; $minor = 0
  if (-not [int]::TryParse($parts[0], [ref] $major)) { return $false }
  if (-not [int]::TryParse($parts[1], [ref] $minor)) { return $false }
  foreach ($clause in ($Range -split '\|\|')) {
    $c = $clause.Trim()
    if ($c -match '^\^(\d+)\.(\d+)$') {
      if ($major -eq [int]$Matches[1] -and $minor -ge [int]$Matches[2]) { return $true }
      continue
    }
    if ($c -match '^>=(\d+)$') {
      if ($major -ge [int]$Matches[1]) { return $true }
      continue
    }
    if ($c -match '^(\d+)\.(\d+)$') {
      if ($major -eq [int]$Matches[1] -and $minor -eq [int]$Matches[2]) { return $true }
    }
  }
  return $false
}

function Get-Nodes {
  return (Get-Content $NodesFile -Raw | ConvertFrom-Json).nodes
}

function New-RunDirectory {
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $path = Join-Path $PSScriptRoot "runs/$stamp"
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  return $path
}

function Invoke-Remote {
  param([string] $Ssh, [string] $Command)
  if (-not $Ssh) { return [pscustomobject]@{ Ok = $false; Out = 'no ssh configured' } }
  $output = (& ssh -o BatchMode=yes -o ConnectTimeout=6 $Ssh $Command 2>&1 | Out-String).Trim()
  return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Out = $output }
}

# The endpoint a peer dials. Under 'serve' this is the proxy, not the backend.
function Get-PublishedTarget {
  param($Node)
  $hostName = $Node.tailscaleName
  if (-not $hostName) { $hostName = $Node.ip }
  $scheme = $Node.published.scheme
  $port = [int] $Node.published.port
  $sub = $Node.published.path
  return [pscustomobject]@{
    Scheme = $scheme
    Host   = $hostName
    Port   = $port
    Path   = $sub
    Base   = ($scheme + '://' + $hostName + ':' + $port + $sub)
    Target = ($hostName + ':' + $port)
  }
}

# Is a TCP port listening on the node itself? Local nodes are inspected
# directly; remote nodes over ssh. This is the precondition that distinguishes a
# genuine refusal from a port nobody is serving.
function Test-NodeListening {
  param($Node, [int] $Port)
  if ($Node.ssh) {
    $r = Invoke-Remote $Node.ssh ("ss -ltn 2>/dev/null | grep -c ':" + $Port + " ' || true")
    if (-not $r.Ok) { return $null }
    return ($r.Out.Trim() -ne '0')
  }
  $conns = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -eq $Port })
  return ($conns.Count -gt 0)
}

function Test-TcpPort {
  param([string] $Target, [int] $Port, [int] $TimeoutMs = 3000)
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $async = $client.BeginConnect($Target, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
    $client.EndConnect($async)
    return $true
  }
  catch { return $false }
  finally { $client.Close() }
}

# Whether the mesh listener is up on a node. T1 binds a unix socket (or a named
# pipe on Windows), so a TCP probe would call a running listener absent.
function Test-MeshListening {
  param($Node)
  if ($Node.listen.kind -ne 'unix') {
    return (Test-NodeListening -Node $Node -Port ([int] $Node.listen.port))
  }
  if ($Node.ssh) {
    $r = Invoke-Remote $Node.ssh ("test -S '" + $Node.listen.path + "' && echo socket || echo none")
    if (-not $r.Ok) { return $null }
    return ($r.Out.Trim() -eq 'socket')
  }
  return (Test-Path $Node.listen.path)
}

function Get-HttpStatus {
  param([string] $Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -TimeoutSec 8 -SkipHttpErrorCheck -SkipCertificateCheck
    return [int] $response.StatusCode
  }
  catch { return $null }
}

# ---- suites ----------------------------------------------------------------

function Invoke-PreflightSuite {
  param($Nodes, [string] $RunDir)
  $doctor = Join-Path $PSScriptRoot 'mesh-doctor.ps1'
  & pwsh -NoProfile -File $doctor -NodesFile $NodesFile | Out-Host
  if (Test-CaseWanted 'E-03') {
    if ($LASTEXITCODE -eq 0) { Add-Result 'E-03' 'pass' 'preflight green' }
    else { Add-Result 'E-03' 'fail' 'preflight reported failures (see above)' }
  }
}

function Invoke-NetworkSuite {
  param($Nodes, [string] $RunDir)

  # E-ARCH-04 first: a machine-level invariant that needs no peer.
  if (Test-CaseWanted 'E-ARCH-04') {
    $serve = (& tailscale serve status 2>&1 | Out-String)
    $funnel = @($serve -split "\r?\n" | Where-Object { $_ -match '^#\s+-\s+' })
    $ports = @()
    foreach ($p in $Nodes.PSObject.Properties) {
      if ($p.Value.pending) { continue }
      $ports += [int] $p.Value.published.port
    }
    $ports = @($ports | Sort-Object -Unique)
    $bad = @()
    foreach ($line in $funnel) { foreach ($port in $ports) { if ($line -match (':' + $port + '\s*$')) { $bad += $line.Trim() } } }
    if ($bad.Count -gt 0) { Add-Result 'E-ARCH-04' 'fail' ("Funnel exposes a mesh port: " + ($bad -join ', ')) }
    else { Add-Result 'E-ARCH-04' 'pass' ("no Funnel listener covers a mesh port (funnel endpoints: " + $funnel.Count + ")") }
  }

  foreach ($property in $Nodes.PSObject.Properties) {
    if ($property.Value.pending) { continue }
    if ($property.Name -eq 'W') { continue }
    $node = $property.Value
    $name = $property.Name
    $webPort = [int] $node.web.port
    $pub = Get-PublishedTarget $node

    # E-ARCH-01: the GUI must be unreachable from another machine. A refusal is
    # only evidence when the GUI is actually running there.
    if (Test-CaseWanted 'E-ARCH-01') {
      $guiListening = Test-NodeListening -Node $node -Port $webPort
      if ($null -eq $guiListening) {
        Add-Result 'E-ARCH-01' 'skip' ($name + ' : cannot determine whether the GUI is running (no ssh); a closed port would prove nothing')
      }
      elseif ($guiListening -eq $false) {
        Add-Result 'E-ARCH-01' 'skip' ($name + ' : the GUI is not running on port ' + $webPort + '; a closed port proves nothing about its bind address')
      }
      else {
        $open = Test-TcpPort -Target $node.ip -Port $webPort
        if ($open) { Add-Result 'E-ARCH-01' 'fail' ($name + ' ' + $node.ip + ':' + $webPort + ' is reachable from this machine while its GUI runs - it must bind loopback only') }
        else { Add-Result 'E-ARCH-01' 'pass' ($name + ' GUI runs on ' + $webPort + ' and is unreachable at ' + $node.ip + ':' + $webPort) }
      }
    }

    # E-ARCH-02: nothing but the anonymous hello may answer on the PUBLISHED endpoint.
    if (Test-CaseWanted 'E-ARCH-02') {
      $meshListening = Test-MeshListening -Node $node
      if ($meshListening -ne $true) {
        Add-Result 'E-ARCH-02' 'skip' ($name + ' : the mesh listener is not running; the published endpoint cannot answer anything yet')
      }
      else {
        foreach ($sub in @('/', '/plugins/x', '/api/session/list')) {
          $status = Get-HttpStatus -Url ($pub.Base + $sub)
          if ($status -eq 404) { Add-Result 'E-ARCH-02' 'pass' ($name + ' ' + $pub.Base + $sub + ' -> 404') }
          elseif ($null -eq $status) { Add-Result 'E-ARCH-02' 'fail' ($name + ' ' + $pub.Base + $sub + ' -> no response through the published endpoint') }
          else { Add-Result 'E-ARCH-02' 'fail' ($name + ' ' + $pub.Base + $sub + ' -> ' + $status + ', expected 404') }
        }
      }
    }

    # E-ARCH-03: the anonymous hello leaks only identity.
    if (Test-CaseWanted 'E-ARCH-03') {
      $meshListening = Test-MeshListening -Node $node
      if ($meshListening -ne $true) {
        Add-Result 'E-ARCH-03' 'skip' ($name + ' : the mesh listener is not running')
      }
      else {
        $hello = Get-HttpStatus -Url ($pub.Base + '/hello')
        if ($hello -eq 200) { Add-Result 'E-ARCH-03' 'pass' ($name + ' published /hello answered 200; field-level assertions run in the pairing suite') }
        else { Add-Result 'E-ARCH-03' 'fail' ($name + ' published /hello -> ' + $hello) }
      }
    }
  }
}

$implementedSuites = @{
  'preflight' = { param($Nodes, $RunDir) Invoke-PreflightSuite -Nodes $Nodes -RunDir $RunDir }
  'network'   = { param($Nodes, $RunDir) Invoke-NetworkSuite -Nodes $Nodes -RunDir $RunDir }
}

$pendingSuites = @{
  'pairing'  = 'E-PAIR-* requires @deepseek-ai/dsh-mesh and @deepseek-ai/dsh-mesh-agent'
  'presence' = 'E-PRES-* requires @deepseek-ai/dsh-mesh-remote'
  'reads'    = 'E-READ-*, E-STREAM-* require @deepseek-ai/dsh-mesh-ops'
  'writes'   = 'E-WRITE-*, E-DENY-*, E-BUDGET-* require the grant policy and a confining preset'
  'ops'      = 'E-OPS-*, E-NET-*, E-LOOP-* require the full mesh composition'
}

# ---- run -------------------------------------------------------------------

if ($KeepRunning) {
  Write-Warning '-KeepRunning has no effect: no implemented suite starts a remote process yet.'
}

$nodes = Get-Nodes
$runDir = New-RunDirectory
Write-Host ("run directory: " + $runDir)
Write-Host ("node range:    " + $ENGINE_RANGE)
Write-Host ''

$selected = @()
if ($Suite -eq 'all') { $selected = @('preflight', 'network', 'pairing', 'presence', 'reads', 'writes', 'ops') }
else { $selected = @($Suite) }

foreach ($name in $selected) {
  if ($implementedSuites.ContainsKey($name)) {
    & $implementedSuites[$name] $nodes $runDir
    continue
  }
  if ($pendingSuites.ContainsKey($name)) {
    Add-Result ("suite:" + $name) 'skip' $pendingSuites[$name]
    continue
  }
  throw ("unknown suite: " + $name)
}

# ---- artifacts and report --------------------------------------------------

Set-Content -Path (Join-Path $runDir 'tailscale-status.json') -Value (& tailscale status --json 2>&1 | Out-String)
Set-Content -Path (Join-Path $runDir 'tailscale-serve.txt') -Value (& tailscale serve status 2>&1 | Out-String)
$script:Results | Export-Csv -Path (Join-Path $runDir 'results.csv') -NoTypeInformation

Write-Host ''
$pass = @($script:Results | Where-Object { $_.Outcome -eq 'pass' }).Count
$fail = @($script:Results | Where-Object { $_.Outcome -eq 'fail' }).Count
$skip = @($script:Results | Where-Object { $_.Outcome -eq 'skip' }).Count
Write-Host ("pass=$pass fail=$fail skip=$skip")
Write-Host ("artifacts: " + $runDir)

if ($fail -gt 0) { exit 1 }
exit 0
