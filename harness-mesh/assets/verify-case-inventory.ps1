<#
.SYNOPSIS
  Verify that every case id used in the plan folder is defined in the case inventory.

.DESCRIPTION
  Scans harness-mesh/**/*.md for case-id tokens and compares them with the ids
  defined in 04-validation/07-case-inventory.md. Reports:
    - ids referenced by a document but not defined (a test that does not exist)
    - ids defined but never referenced (dead weight)
  Exits 1 on an undefined reference, which is the failure that matters.

.PARAMETER Root
  The plan folder. Defaults to the parent of this script's directory.

.EXAMPLE
  pwsh ./verify-case-inventory.ps1
#>
[CmdletBinding()]
param(
  [string] $Root = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'

$inventoryPath = Join-Path $Root '04-validation/07-case-inventory.md'
if (-not (Test-Path $inventoryPath)) { throw "case inventory not found: $inventoryPath" }

# E-00 .. E-05 are the two-digit preflight ids; everything else is X-NAME-NN.
$pattern = '\b(?:[UIW]-[A-Z][A-Z0-9]*-[0-9]{2}|E-[A-Z][A-Z0-9]*-[0-9]{2}|E-[0-9]{2}|O-[0-9]{2})\b'

$inventoryText = Get-Content $inventoryPath -Raw
$defined = [System.Collections.Generic.HashSet[string]]::new()
foreach ($m in [regex]::Matches($inventoryText, $pattern)) { [void] $defined.Add($m.Value) }

$referenced = @{}
Get-ChildItem $Root -Recurse -File -Filter *.md | ForEach-Object {
  if ($_.FullName -eq $inventoryPath) { return }
  $rel = $_.FullName.Substring($Root.Length).TrimStart('\', '/')
  foreach ($m in [regex]::Matches((Get-Content $_.FullName -Raw), $pattern)) {
    if (-not $referenced.ContainsKey($m.Value)) { $referenced[$m.Value] = @() }
    if ($referenced[$m.Value] -notcontains $rel) { $referenced[$m.Value] += $rel }
  }
}

$undefined = @($referenced.Keys | Where-Object { -not $defined.Contains($_) } | Sort-Object)
$unused = @($defined | Where-Object { -not $referenced.ContainsKey($_) } | Sort-Object)

Write-Host ("defined:    " + $defined.Count)
Write-Host ("referenced: " + $referenced.Count)

if ($undefined.Count -gt 0) {
  Write-Host ''
  Write-Host ($undefined.Count.ToString() + ' case id(s) referenced but NOT defined in the inventory:') -ForegroundColor Red
  foreach ($id in $undefined) { Write-Host ("  " + $id + "  <- " + ($referenced[$id] -join ', ')) -ForegroundColor Red }
}

if ($unused.Count -gt 0) {
  Write-Host ''
  Write-Host ($unused.Count.ToString() + ' case id(s) defined but never referenced:') -ForegroundColor Yellow
  Write-Host ("  " + ($unused -join ', ')) -ForegroundColor Yellow
}

if ($undefined.Count -gt 0) { exit 1 }
Write-Host ''
Write-Host 'every referenced case id is defined' -ForegroundColor Green
exit 0
