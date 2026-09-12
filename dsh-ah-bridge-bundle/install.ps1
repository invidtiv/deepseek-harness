# Installs the dsh-ah-bridge plugin into a DSH profile so the ah_* Android
# harness tools are registered by the host composition in every session.
#
# Usage:
#   .\install.ps1                              # profile "web" under $DSH_HOME (or ~\.dsh)
#   .\install.ps1 -ProfileName cli             # a differently named profile
#   .\install.ps1 -ProfileDir C:\path\profile  # explicit profile directory
#   .\install.ps1 -VerifyOnly                  # run the checks without changing anything
#
# What it does (idempotent — safe to re-run after upgrading index.js):
#   1. copies packages/dsh-ah-bridge into <profile>\packages\dsh-ah-bridge
#   2. adds "packages/*" to pnpm-workspace.yaml (if missing)
#   3. adds the "dsh-ah-bridge": "workspace:*" dependency to package.json
#   4. appends the ah-bridge insert row to cordis.patch.yml (if missing)
#   5. runs pnpm install (falls back to a direct node_modules copy if pnpm is unavailable)
#   6. verifies: module import + full patch-stack composition
#
# The tools mount at the next harness restart (profile start).

[CmdletBinding()]
param(
  [string]$ProfileName = 'web',
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [string]$ProfileDir = '',
  [switch]$VerifyOnly,
  [switch]$SkipInstall
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$srcPackage = Join-Path $here 'packages\dsh-ah-bridge'

if (-not (Test-Path (Join-Path $srcPackage 'index.js'))) {
  throw "Bundle is incomplete: missing $srcPackage\index.js"
}

if (-not $ProfileDir) {
  $ProfileDir = Join-Path $DshHome "profiles\$ProfileName"
}
if (-not (Test-Path (Join-Path $ProfileDir 'package.json'))) {
  throw "Profile directory not found or not a profile: $ProfileDir"
}
Write-Host "Target profile: $ProfileDir"

$wsPath = Join-Path $ProfileDir 'pnpm-workspace.yaml'
$pjPath = Join-Path $ProfileDir 'package.json'
$patchPath = Join-Path $ProfileDir 'cordis.patch.yml'

if ($VerifyOnly) {
  Write-Host 'VerifyOnly: skipping all edits.' -ForegroundColor Yellow
}
else {
  # 1. copy the plugin package
  $dstPackage = Join-Path $ProfileDir 'packages\dsh-ah-bridge'
  New-Item -ItemType Directory -Force -Path $dstPackage | Out-Null
  Copy-Item (Join-Path $srcPackage '*') $dstPackage -Recurse -Force
  Write-Host "[1/6] copied plugin package -> $dstPackage"

  # 2. workspace membership
  $ws = Get-Content $wsPath -Raw
  if ($ws -match '(?m)^packages:\s*$' -and $ws -notmatch '(?m)^\s*-\s*packages/\*\s*$') {
    $ws = $ws -replace '(?m)^packages:\s*$', "packages:`n  - packages/*"
    Set-Content -Path $wsPath -Value $ws -Encoding UTF8
    Write-Host '[2/6] added "packages/*" to pnpm-workspace.yaml'
  }
  elseif ($ws -match '(?m)^\s*-\s*packages/\*\s*$') {
    Write-Host '[2/6] pnpm-workspace.yaml already includes packages/*'
  }
  else {
    Write-Warning '[2/6] pnpm-workspace.yaml has an unrecognized packages: form - add "  - packages/*" under it manually.'
  }

  # 3. profile dependency
  $pj = Get-Content $pjPath -Raw | ConvertFrom-Json
  $needsDep = $true
  if ($pj.PSObject.Properties['dependencies'] -and $pj.dependencies.PSObject.Properties['dsh-ah-bridge']) {
    if ($pj.dependencies.'dsh-ah-bridge' -eq 'workspace:*') { $needsDep = $false }
  }
  if ($needsDep) {
    if (-not $pj.PSObject.Properties['dependencies']) {
      $pj | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{})
    }
    $pj.dependencies | Add-Member -NotePropertyName 'dsh-ah-bridge' -NotePropertyValue 'workspace:*' -Force
    $pj | ConvertTo-Json -Depth 20 | Set-Content -Path $pjPath -Encoding UTF8
    Write-Host '[3/6] added "dsh-ah-bridge": "workspace:*" to package.json'
  }
  else {
    Write-Host '[3/6] package.json already declares the dependency'
  }

  # 4. composition row
  $insertBlock = @'
- insert:
    # Native control of the LDPlayer Android harness: the ah-bridge host row
    # registers the ah_* model tools (android-harness/1 RPC over ADB, no ahctl
    # CLI) in every session of this profile. Source: packages/dsh-ah-bridge/.
    - id: ah-bridge
      name: dsh-ah-bridge
'@
  $patchContent = if (Test-Path $patchPath) { Get-Content $patchPath -Raw } else { '' }
  if ($patchContent -match 'dsh-ah-bridge') {
    Write-Host '[4/6] cordis.patch.yml already contains the ah-bridge row'
  }
  elseif ($patchContent.Trim() -eq '[]' -or $patchContent.Trim() -eq '') {
    $header = "# Your patch layer for this dsh profile, applied after every bundle layer:`n# a top-level YAML array of loader patch entries (id-targeted config`n# overrides, disables, and insert lists; ``!!js`` expressions allowed).`n"
    Set-Content -Path $patchPath -Value ($header + $insertBlock) -Encoding UTF8
    Write-Host '[4/6] created cordis.patch.yml with the ah-bridge insert row'
  }
  else {
    Add-Content -Path $patchPath -Value ("`n" + $insertBlock) -Encoding UTF8
    Write-Host '[4/6] appended the ah-bridge insert row to cordis.patch.yml'
  }
}

# 5. install (pnpm managed node_modules; direct copy fallback)
$link = Join-Path $ProfileDir 'node_modules\dsh-ah-bridge'
if (-not $SkipInstall -and -not $VerifyOnly) {
  $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
  if ($pnpm) {
    Push-Location $ProfileDir
    try {
      pnpm install --reporter=append-only
      if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
    }
    finally { Pop-Location }
    Write-Host '[5/6] pnpm install complete'
  }
  else {
    Write-Warning '[5/6] pnpm not found - installing by direct node_modules copy instead'
  }
  if (-not (Test-Path $link)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $ProfileDir 'node_modules') | Out-Null
    Copy-Item $srcPackage $link -Recurse -Force
    Write-Host '[5/6] fallback: copied package directly into node_modules (a later pnpm install would prune it - prefer installing pnpm)'
  }
  else {
    Write-Host '[5/6] node_modules\dsh-ah-bridge resolves'
  }
}
else {
  Write-Host "[5/6] skipped install (link present: $(Test-Path $link))"
}

# 6. verify
$ok = $true

# 6a. the peer import: distinguish a broken install from a missing in-box tree
$peerOk = $false
$prevEap = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
try {
  Push-Location $ProfileDir
  node --input-type=module -e "await import('@deepseek-ai/dsh-tools')" 2>$null
  if ($LASTEXITCODE -eq 0) { $peerOk = $true }
}
catch { }
finally { Pop-Location; $ErrorActionPreference = $prevEap }

if (-not $peerOk) {
  Write-Warning "[6/6] '@deepseek-ai/dsh-tools' is not resolvable from this profile. Real DSH deployments maintain the shared profiles\node_modules fallback tree; without it, copy or link dsh-tools into the profile's node_modules."
}

try {
  Push-Location $ProfileDir
  $probe = node --input-type=module -e "const m = await import('dsh-ah-bridge'); console.log((m.name === 'ah-bridge' ? 'ok' : 'BAD_NAME') + ' apply=' + typeof m.apply)"
  if ($probe -match 'ok apply=function') { Write-Host "[6/6] import check: $probe" }
  else { throw "unexpected probe output: $probe" }
}
catch {
  $ok = $false
  Write-Warning "[6/6] import check failed: $($_.Exception.Message)"
}
finally { Pop-Location }

# 6b. full patch-stack composition, bundles derived from the profile manifest
try {
  Push-Location $ProfileDir
  $node = @'
const fs = await import('node:fs');
const profileDir = process.argv[1];
const patchPath = process.argv[2];
const flat = process.argv[3];
const m = await import('@deepseek-ai/dsh-app-boot');
function bundleDir(bundle) {
  for (const root of [profileDir + '/node_modules', flat]) {
    const dir = root + '/' + bundle;
    if (fs.existsSync(dir + '/package.json')) return dir;
  }
  throw new Error('bundle not resolvable: ' + bundle);
}
const pj = JSON.parse(fs.readFileSync(profileDir + '/package.json', 'utf8'));
const bundles = pj?.dsh?.profile?.bundles ?? [];
const layers = [];
for (const bundle of bundles) {
  const dir = bundleDir(bundle);
  const pkg = JSON.parse(fs.readFileSync(dir + '/package.json', 'utf8'));
  const rel = pkg?.dsh?.bundle?.patch ?? './cordis.patch.yml';
  layers.push(m.loadOverlayPatches('verify', dir + '/' + rel));
}
const user = m.loadOptionalPatches('verify', patchPath) ?? [];
const warnings = [];
const entries = m.composeEntries([...layers, user], (msg) => warnings.push(msg));
const rows = entries.filter(e => e.id === 'ah-bridge');
console.log('bundles=' + bundles.length + ' entries=' + entries.length + ' ah-bridge=' + rows.length + ' warnings=' + warnings.length);
'@
  $result = node --input-type=module -e $node $ProfileDir $patchPath (Join-Path $DshHome 'profiles\node_modules') 2>$null
  if ($LASTEXITCODE -ne 0) { throw 'composition probe could not run (see note below)' }
  if ($result -match 'ah-bridge=1 warnings=0') { Write-Host "[6/6] composition check: $result" }
  else { Write-Warning "[6/6] composition check unexpected: $result" }
}
catch {
  Write-Warning "[6/6] composition check skipped: $($_.Exception.Message) — outside a full DSH home (@deepseek-ai/dsh-app-boot not resolvable), run the check inside the real profile."
}
finally { Pop-Location }

if ($ok) {
  Write-Host ''
  Write-Host 'Done. Restart the harness profile to mount the ah-bridge row' -ForegroundColor Green
  Write-Host '(the profile patch layer mounts at start; verify with the ah_devices tool afterwards).' -ForegroundColor Green
}
