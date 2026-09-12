/**
 * dsh-ah-bridge — native control of the LDPlayer Android harness.
 *
 * Registers the `ah_*` model tools that speak the Android Harness RPC protocol
 * (`android-harness/1`) directly over ADB (`adb shell content call --uri
 * content://com.androidharness.agent.rpc`), with no ahctl CLI, no shell
 * parsing, and structured JSON results. Mounted as a host-composition row via
 * the profile's cordis.patch.yml, so every session of this deployment gets the
 * tools without any per-session setup.
 *
 * Every tool accepts an optional `device` serial; without one, a sticky
 * default is auto-resolved from the first online emulator and reused.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'ah-bridge'
export const inject = ['subprocess', 'timer', 'tools', 'systemPrompt']

const RPC_PROTOCOL = 'android-harness/1'
const RPC_URI = 'content://com.androidharness.agent.rpc'
const RESPONSE_RE = /(?:^|[^A-Za-z0-9_-])response=([A-Za-z0-9_-]+)/

export function apply(ctx) {
  const subprocess = ctx.subprocess
  const timer = ctx.timer
  let defaultDevice = null
  let seq = 0
  let workspaceRoot = '.'

  const policy = ctx.get('sandboxPolicy')
  if (policy !== undefined && typeof policy.workspaceRoot === 'string') workspaceRoot = policy.workspaceRoot

  function b64urlEncode(text) {
    const bytes = new TextEncoder().encode(text)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    }
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  }

  function b64urlDecode(encoded) {
    let b64 = String(encoded).replace(/-/g, '+').replace(/_/g, '/')
    while (b64.length % 4 !== 0) b64 += '='
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return JSON.parse(new TextDecoder().decode(bytes))
  }

  function clean(obj) {
    const out = {}
    for (const key of Object.keys(obj)) {
      const value = obj[key]
      if (value !== undefined && value !== null) out[key] = value
    }
    return out
  }

  async function runAdb(serial, args, timeoutMs) {
    const budget = timeoutMs > 0 ? timeoutMs : 30000
    const adb = await subprocess.resolveExecutable('adb', undefined, undefined)
    const argv = [adb]
    if (serial) {
      argv.push('-s')
      argv.push(serial)
    }
    for (const a of args) argv.push(a)
    const handle = subprocess.spawn({
      argv,
      cwd: workspaceRoot,
      graceMs: 2000,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 12 * 1024 * 1024, spill: { maxBytes: 32 * 1024 * 1024 } },
        stderr: { maxBytes: 65536 },
      },
    })
    let timedOut = false
    const cancel = timer.timeout(() => {
      timedOut = true
      handle.terminate()
    }, budget + 5000)
    try {
      const outcome = await handle.done
      if (timedOut) {
        throw new Error('adb timed out after ' + (budget + 5000) + 'ms' + (serial ? ' on ' + serial : '') + ': ' + args.join(' '))
      }
      if (outcome.exitCode !== 0) {
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text.trim() : ''
        throw new Error('adb exited ' + outcome.exitCode + (err ? ': ' + err.slice(0, 500) : ''))
      }
      return handle.collected.stdout.readFrom(0).text
    } finally {
      cancel()
    }
  }

  async function adbDevices() {
    const out = await runAdb(null, ['devices'], 10000)
    const devices = []
    for (const line of out.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.indexOf('List of devices') === 0 || trimmed.indexOf('*') === 0) continue
      const parts = trimmed.split(/\s+/)
      if (parts.length >= 2 && parts[0] && parts[1]) {
        devices.push({ serial: parts[0], state: parts[1] })
      }
    }
    return devices
  }

  async function resolveDevice(explicit) {
    if (explicit) return explicit
    if (defaultDevice) return defaultDevice
    const online = (await adbDevices()).filter(d => d.state === 'device')
    if (online.length === 0) {
      throw new Error('No online ADB devices found. Ensure LDPlayer is running and accessible.')
    }
    online.sort((a, b) => (a.serial < b.serial ? -1 : 1))
    defaultDevice = online[0].serial
    return defaultDevice
  }

  async function callHarness(explicitDevice, method, params, timeoutMs, sessionId) {
    const serial = await resolveDevice(explicitDevice)
    seq += 1
    const request = { protocol: RPC_PROTOCOL, id: 'ah_' + seq, method, params: params || {} }
    if (sessionId) request.session_id = sessionId
    const encoded = b64urlEncode(JSON.stringify(request))
    const out = await runAdb(
      serial,
      ['shell', 'content', 'call', '--uri', RPC_URI, '--method', 'rpc', '--extra', 'request:s:' + encoded],
      timeoutMs > 0 ? timeoutMs : 30000,
    )
    const match = RESPONSE_RE.exec(out)
    if (!match) {
      throw new Error('Harness RPC returned no response bundle: ' + out.trim().slice(0, 300))
    }
    const response = b64urlDecode(match[1])
    if (response.protocol !== RPC_PROTOCOL) throw new Error('Unsupported RPC protocol: ' + response.protocol)
    if (response.id !== request.id) throw new Error('RPC response id mismatch: expected ' + request.id + ' got ' + response.id)
    if (response.ok !== true) {
      const error = response.error || {}
      throw new Error(method + ' failed: ' + (error.code || 'RPC_ERROR') + ': ' + (error.message || 'request failed'))
    }
    const result = response.result
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('Successful RPC response is missing an object result')
    }
    return { device: serial, result }
  }

  function registerAhTool(spec) {
    ctx.tools.register(defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters || {},
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      timeoutMs: (spec.adbBudget || 30000) + 20000,
      execute(args) {
        return spec.run(clean(args), args.device)
      },
    }))
  }

  function rpcRun(method, build, adbBudget) {
    return async function (args, device) {
      const params = build ? build(args) : args
      const response = await callHarness(device, method, params, adbBudget)
      return { device: response.device, method, result: response.result }
    }
  }

  const DEVICE_PARAM = {
    type: 'string',
    description: 'ADB serial (e.g. emulator-5554). Omit to use the sticky default device (auto-resolved first online emulator).',
  }
  function withDevice(params) {
    params.device = DEVICE_PARAM
    return params
  }

  // ---- device inventory (no RPC needed) ----
  registerAhTool({
    name: 'ah_devices',
    description: 'List ADB devices with state, Android-harness version, and root (su) availability. Also shows which device the sticky default resolved to. Call this first when unsure which emulator to target.',
    parameters: {},
    run: async function () {
      const devices = await adbDevices()
      const report = []
      for (const d of devices) {
        const entry = { serial: d.serial, state: d.state, harness: '-', root: null }
        if (d.state === 'device') {
          try {
            const st = await callHarness(d.serial, 'harness.status', {}, 10000)
            entry.harness = st.result.version || 'unknown'
          } catch {
            entry.harness = 'not running'
          }
          try {
            const su = await runAdb(d.serial, ['shell', 'su', '-c', 'id'], 8000)
            entry.root = su.indexOf('uid=0') >= 0
          } catch {
            entry.root = false
          }
        }
        report.push(entry)
      }
      return { devices: report, default_device: defaultDevice }
    },
  })

  // ---- simple runtime probes ----
  registerAhTool({
    name: 'ah_status',
    description: 'Android harness runtime status: state, paused flag, version, active plugin count, started_at, last_error.',
    parameters: withDevice({}),
    run: rpcRun('harness.status'),
  })
  registerAhTool({
    name: 'ah_version',
    description: 'Host-relevant harness versions: app version, RPC protocol, daemon protocol, plugin API.',
    parameters: withDevice({}),
    run: rpcRun('harness.version'),
  })
  registerAhTool({
    name: 'ah_doctor',
    description: 'Run harness readiness checks (doctor). Returns overall status plus per-check pass/fail with remediation hints.',
    parameters: withDevice({}),
    adbBudget: 60000,
    run: rpcRun('harness.doctor'),
  })
  registerAhTool({
    name: 'ah_context',
    description: 'Agent orientation context: harness identity, device environment summary, runtime state, active plugin count.',
    parameters: withDevice({}),
    run: rpcRun('harness.context'),
  })
  registerAhTool({
    name: 'ah_capabilities',
    description: 'Which harness capabilities are active: environment, storage, events, workbench, root, daemon, models, memory.',
    parameters: withDevice({}),
    run: rpcRun('harness.capabilities'),
  })
  registerAhTool({
    name: 'ah_environment',
    description: 'Inspect the Android environment: OS version, API level, ABI, device model, emulator vendor detection, and available utilities (su, sqlite3, logcat, dumpsys, uiautomator).',
    parameters: withDevice({}),
    run: rpcRun('environment.inspect'),
  })

  // ---- events ----
  registerAhTool({
    name: 'ah_events',
    description: 'Recent in-memory runtime events, or persisted history with offset paging. Each event: type, source, timestamp, data.',
    parameters: withDevice({
      history: { type: 'boolean', description: 'Read persisted history instead of the in-memory recent buffer.' },
      limit: { type: 'integer', description: 'Maximum number of events (1-1000, default 100).' },
      offset: { type: 'integer', description: 'History offset (only used with history).' },
    }),
    run: function (args, device) {
      const method = args.history ? 'events.history' : 'events.recent'
      const params = { limit: args.limit, offset: args.history ? args.offset : undefined }
      return callHarness(device, method, clean(params)).then(r => ({ device: r.device, method, result: r.result }))
    },
  })

  // ---- plugins and packages ----
  registerAhTool({
    name: 'ah_plugins',
    description: 'List compiled harness plugins (id, version, state, requires, provides, error) or inspect one by id.',
    parameters: withDevice({
      id: { type: 'string', description: 'Inspect a specific plugin id instead of listing all.' },
    }),
    run: function (args, device) {
      const method = args.id ? 'plugins.get' : 'plugins.list'
      return callHarness(device, method, args.id ? { id: args.id } : {}).then(r => ({ device: r.device, method, result: r.result }))
    },
  })
  registerAhTool({
    name: 'ah_packages',
    description: 'List installed Android packages or inspect one package by name.',
    parameters: withDevice({
      pkg: { type: 'string', description: 'Inspect a specific package name instead of listing.' },
      include_system: { type: 'boolean', description: 'Include system packages in the listing.' },
    }),
    run: function (args, device) {
      const method = args.pkg ? 'packages.get' : 'packages.list'
      const params = args.pkg ? { package: args.pkg } : { include_system: args.include_system === true }
      return callHarness(device, method, params).then(r => ({ device: r.device, method, result: r.result }))
    },
  })

  // ---- target / app / daemon control ----
  registerAhTool({
    name: 'ah_target',
    description: 'Get or set the selected target package (the app under investigation).',
    parameters: withDevice({
      action: { type: 'string', enum: ['get', 'set'], required: true, description: 'get returns the current target; set selects a new one.' },
      package: { type: 'string', description: 'Package name (required for set).' },
    }),
    run: function (args, device) {
      const method = args.action === 'set' ? 'target.set' : 'target.get'
      return callHarness(device, method, args.action === 'set' ? { package: args.package } : {}).then(r => ({ device: r.device, method, result: r.result }))
    },
  })
  registerAhTool({
    name: 'ah_app',
    description: 'Launch, force-stop, clear data of, or check status of the target app. Package defaults to the selected target.',
    parameters: withDevice({
      action: { type: 'string', enum: ['launch', 'stop', 'clear', 'status'], required: true, description: 'App operation.' },
      package: { type: 'string', description: 'Package override; defaults to the selected target.' },
    }),
    run: function (args, device) {
      const params = args.package ? { package: args.package } : {}
      const method = 'app.' + args.action
      return callHarness(device, method, params).then(r => ({ device: r.device, method, result: r.result }))
    },
  })
  registerAhTool({
    name: 'ah_daemon',
    description: 'Harness root daemon (harnessd) status or restart: running flag, version, protocol, socket path.',
    parameters: withDevice({
      action: { type: 'string', enum: ['status', 'restart'], required: true, description: 'status reads daemon state; restart restarts harnessd.' },
    }),
    run: function (args, device) {
      const method = 'daemon.' + args.action
      return callHarness(device, method, {}).then(r => ({ device: r.device, method, result: r.result }))
    },
  })

  // ---- diagnostic tools ----
  registerAhTool({
    name: 'ah_tools_list',
    description: 'List device-side diagnostic tools (name, category, mutation type, root requirement, schemas), optionally filtered by category.',
    parameters: withDevice({
      category: { type: 'string', description: 'Filter tools by category.' },
    }),
    run: function (args, device) {
      return callHarness(device, 'tools.list', {}).then(r => {
        let tools = r.result.tools || []
        if (args.category) tools = tools.filter(t => t.category === args.category)
        return { device: r.device, method: 'tools.list', result: { tools } }
      })
    },
  })
  registerAhTool({
    name: 'ah_tool_call',
    description: 'Execute a device-side diagnostic tool by name, e.g. shell.root_exec, input.tap, sqlite.query, screenshot.capture. Pass tool params as a JSON object.',
    parameters: withDevice({
      name: { type: 'string', required: true, description: 'Tool name, e.g. shell.root_exec, input.tap, sqlite.query.' },
      params: { type: 'json', description: 'Tool parameters object.' },
      adb_timeout_ms: { type: 'integer', description: 'ADB transport budget in ms (default 120000, max 200000).' },
    }),
    adbBudget: 220000,
    run: function (args, device) {
      const budget = Math.min(Math.max(args.adb_timeout_ms || 120000, 5000), 200000)
      return callHarness(device, 'tools.call', { name: args.name, params: args.params || {} }, budget).then(r => ({ device: r.device, method: 'tools.call', result: r.result }))
    },
  })
  registerAhTool({
    name: 'ah_tool_describe',
    description: 'Describe one device-side diagnostic tool: full input/output schema, root requirement, mutation type.',
    parameters: withDevice({
      name: { type: 'string', required: true, description: 'Tool name.' },
    }),
    run: rpcRun('tools.describe', args => ({ name: args.name })),
  })

  // ---- workflows ----
  registerAhTool({
    name: 'ah_workflows',
    description: 'List available diagnostic workflows (id, title, description).',
    parameters: withDevice({}),
    run: rpcRun('workflows.list'),
  })
  registerAhTool({
    name: 'ah_workflow_describe',
    description: 'Describe one diagnostic workflow: steps, required params, expected duration.',
    parameters: withDevice({
      id: { type: 'string', required: true, description: 'Workflow id, e.g. workflow.crash_capture.' },
    }),
    run: rpcRun('workflows.describe', args => ({ id: args.id })),
  })
  registerAhTool({
    name: 'ah_workflow_run',
    description: 'Run a diagnostic workflow with JSON params. This can take minutes; budget defaults to 300s.',
    parameters: withDevice({
      id: { type: 'string', required: true, description: 'Workflow id, e.g. workflow.login_capture.' },
      params: { type: 'json', description: 'Workflow parameters object.' },
      adb_timeout_ms: { type: 'integer', description: 'ADB transport budget in ms (default 300000, max 560000).' },
    }),
    adbBudget: 580000,
    run: function (args, device) {
      const budget = Math.min(Math.max(args.adb_timeout_ms || 300000, 5000), 560000)
      return callHarness(device, 'workflows.run', { id: args.id, params: args.params || {} }, budget).then(r => ({ device: r.device, method: 'workflows.run', result: r.result }))
    },
  })

  // ---- skills ----
  registerAhTool({
    name: 'ah_skills',
    description: 'List available on-device diagnostic skills or fetch one skill detail by id.',
    parameters: withDevice({
      id: { type: 'string', description: 'Skill id, e.g. skill.crash_analysis; omit to list all.' },
    }),
    run: function (args, device) {
      const method = args.id ? 'skills.get' : 'skills.list'
      return callHarness(device, method, args.id ? { id: args.id } : {}).then(r => ({ device: r.device, method, result: r.result }))
    },
  })

  // ---- artifacts ----
  registerAhTool({
    name: 'ah_artifacts',
    description: 'List artifacts (id, name, type, size, path, sha256) optionally filtered by type and/or session id.',
    parameters: withDevice({
      type: { type: 'string', description: 'Filter by artifact type.' },
      session_id: { type: 'string', description: 'Filter by session id.' },
    }),
    run: rpcRun('artifacts.list', args => clean({ type: args.type, session_id: args.session_id })),
  })
  registerAhTool({
    name: 'ah_artifact_get',
    description: 'Get one artifact metadata record by id.',
    parameters: withDevice({
      id: { type: 'string', required: true, description: 'Artifact id.' },
    }),
    run: rpcRun('artifacts.get', args => ({ id: args.id })),
  })
  registerAhTool({
    name: 'ah_artifact_read',
    description: 'Read a chunk of artifact content as base64. Defaults: offset 0, length 256KiB. Page with offset to pull large artifacts.',
    parameters: withDevice({
      id: { type: 'string', required: true, description: 'Artifact id.' },
      offset: { type: 'integer', description: 'Byte offset to read from.' },
      length: { type: 'integer', description: 'Chunk length in bytes (default 262144).' },
    }),
    adbBudget: 60000,
    run: function (args, device) {
      return callHarness(device, 'artifacts.read', {
        id: args.id,
        offset: args.offset || 0,
        length: args.length || 262144,
      }, 60000).then(r => ({ device: r.device, method: 'artifacts.read', result: r.result }))
    },
  })
  registerAhTool({
    name: 'ah_artifact_delete',
    description: 'Delete an artifact by id.',
    parameters: withDevice({
      id: { type: 'string', required: true, description: 'Artifact id.' },
    }),
    run: rpcRun('artifacts.delete', args => ({ id: args.id })),
  })
  registerAhTool({
    name: 'ah_pull',
    description: 'Pull an artifact file from the device to a local host file via adb pull (binary-safe). If pull fails due to permissions, fall back to ah_artifact_read chunks.',
    parameters: withDevice({
      artifact_id: { type: 'string', required: true, description: 'Artifact id (its device path is resolved via artifacts.get).' },
      out: { type: 'string', description: 'Local destination path; defaults to <artifactId>_<name> under the workspace.' },
    }),
    adbBudget: 180000,
    run: async function (args, device) {
      const serial = await resolveDevice(device)
      const meta = await callHarness(serial, 'artifacts.get', { id: args.artifact_id }, 30000)
      const remotePath = meta.result.path
      if (!remotePath) throw new Error('Artifact has no device path; use ah_artifact_read instead')
      const safeName = String(meta.result.name || 'artifact.bin').replace(/[^A-Za-z0-9._-]+/g, '_')
      const out = args.out || (args.artifact_id + '_' + safeName)
      await runAdb(serial, ['pull', remotePath, out], 180000)
      return { device: serial, artifact_id: args.artifact_id, remote_path: remotePath, saved_to: out, size_bytes: meta.result.size_bytes }
    },
  })

  // ---- snapshots ----
  registerAhTool({
    name: 'ah_snapshot_capture',
    description: 'Capture a diagnostic state snapshot (preferences, sqlite, file tree) of the target package. Returns a compact summary; full body is an artifact.',
    parameters: withDevice({
      label: { type: 'string', description: 'Snapshot label; defaults to a timestamped label.' },
      package: { type: 'string', description: 'Target package; defaults to the selected target.' },
    }),
    adbBudget: 120000,
    run: rpcRun('snapshots.capture', args => clean({ label: args.label, package: args.package })),
  })
  registerAhTool({
    name: 'ah_snapshots',
    description: 'List recorded state snapshots, optionally filtered by target package.',
    parameters: withDevice({
      package: { type: 'string', description: 'Filter by target package.' },
    }),
    run: rpcRun('snapshots.list', args => clean({ package: args.package })),
  })
  registerAhTool({
    name: 'ah_snapshot_get',
    description: 'Fetch one full state snapshot by id (can be large).',
    parameters: withDevice({
      id: { type: 'string', required: true, description: 'Snapshot id.' },
    }),
    run: rpcRun('snapshots.get', args => ({ id: args.id })),
  })
  registerAhTool({
    name: 'ah_snapshot_diff',
    description: 'Diff two state snapshots; returns structured diff plus a markdown rendering.',
    parameters: withDevice({
      snapshot_a: { type: 'string', required: true, description: 'Baseline snapshot id.' },
      snapshot_b: { type: 'string', required: true, description: 'Current snapshot id.' },
    }),
    run: rpcRun('snapshots.diff', args => ({ snapshot_a: args.snapshot_a, snapshot_b: args.snapshot_b })),
  })

  // ---- sessions ----
  registerAhTool({
    name: 'ah_session',
    description: 'Manage investigation sessions: new (create), active, list, get, timeline, resume, pause, close. timeline pages through the session activity log.',
    parameters: withDevice({
      action: { type: 'string', enum: ['new', 'active', 'list', 'get', 'timeline', 'resume', 'pause', 'close'], required: true, description: 'Session operation.' },
      id: { type: 'string', description: 'Session id (required for get/timeline/resume/pause/close).' },
      title: { type: 'string', description: 'Session title (for new).' },
      objective: { type: 'string', description: 'Investigation objective (for new); defaults to a generic objective.' },
      package: { type: 'string', description: 'Target package (for new).' },
      limit: { type: 'integer', description: 'Timeline page size (1-200, default 100).' },
      offset: { type: 'integer', description: 'Timeline offset.' },
    }),
    run: function (args, device) {
      const method = 'session.' + (args.action === 'new' ? 'create' : args.action)
      let params = {}
      if (args.action === 'new') {
        params = clean({ title: args.title || 'Diagnostic Session', objective: args.objective || 'Investigate target application', package: args.package })
      } else if (args.action === 'timeline') {
        params = { id: args.id, limit: args.limit || 100, offset: args.offset || 0 }
      } else if (args.id) {
        params = { id: args.id }
      }
      return callHarness(device, method, params).then(r => ({ device: r.device, method, result: r.result }))
    },
  })
  registerAhTool({
    name: 'ah_session_observe',
    description: 'Record an observation in the active (or given) session, with importance normal/high/critical and optional artifact evidence id.',
    parameters: withDevice({
      text: { type: 'string', required: true, description: 'Observation text.' },
      importance: { type: 'string', enum: ['normal', 'high', 'critical'], description: 'Importance level (default normal).' },
      artifact_id: { type: 'string', description: 'Associated artifact id.' },
      session_id: { type: 'string', description: 'Session id; defaults to the active session.' },
    }),
    run: rpcRun('session.observation.add', args => clean({ text: args.text, importance: args.importance, artifact_id: args.artifact_id, session_id: args.session_id })),
  })
  registerAhTool({
    name: 'ah_session_bookmark',
    description: 'Record a change bookmark in the active (or given) session: action performed, summary, and optional target (traceability metadata).',
    parameters: withDevice({
      action: { type: 'string', description: 'Action performed, e.g. app.clear.' },
      summary: { type: 'string', description: 'Human summary of the change.' },
      target: { type: 'string', description: 'Affected target (file, pref key, table, ...).' },
      session_id: { type: 'string', description: 'Session id; defaults to the active session.' },
    }),
    run: rpcRun('session.bookmark.add', args => clean({ action: args.action, summary: args.summary, target: args.target, session_id: args.session_id })),
  })
  registerAhTool({
    name: 'ah_session_export',
    description: 'Export a session report as markdown or json. Returns the report body inline plus a persisted artifact id.',
    parameters: withDevice({
      id: { type: 'string', description: 'Session id; defaults to the active session.' },
      format: { type: 'string', enum: ['md', 'json'], description: 'Body format (default md).' },
    }),
    run: rpcRun('session.export', args => clean({ id: args.id, format: args.format })),
  })
  registerAhTool({
    name: 'ah_task',
    description: 'Set the current investigation objective: creates a new session titled from the objective (the ahctl task command).',
    parameters: withDevice({
      objective: { type: 'string', required: true, description: 'Plain language objective to set.' },
      package: { type: 'string', description: 'Optional target package.' },
    }),
    run: rpcRun('session.create', args => clean({ title: String(args.objective).slice(0, 40), objective: args.objective, package: args.package })),
  })

  // ---- providers ----
  registerAhTool({
    name: 'ah_providers',
    description: 'Manage on-device model profiles: list (with selected), get, select, or delete a profile by id.',
    parameters: withDevice({
      action: { type: 'string', enum: ['list', 'get', 'select', 'delete'], required: true, description: 'Provider operation.' },
      id: { type: 'string', description: 'Profile id (required for get/select/delete).' },
    }),
    run: function (args, device) {
      const method = 'providers.' + args.action
      return callHarness(device, method, args.id ? { id: args.id } : {}).then(r => ({ device: r.device, method, result: r.result }))
    },
  })
  registerAhTool({
    name: 'ah_provider_models',
    description: "Fetch a provider profile's current model catalog using its endpoint and credential.",
    parameters: withDevice({
      id: { type: 'string', required: true, description: 'Profile id.' },
    }),
    adbBudget: 60000,
    run: rpcRun('providers.models', args => ({ id: args.id }), 60000),
  })
  registerAhTool({
    name: 'ah_provider_set_model',
    description: "Change a profile's model without replacing its credential.",
    parameters: withDevice({
      id: { type: 'string', required: true, description: 'Profile id.' },
      model: { type: 'string', required: true, description: 'Model identifier returned by ah_provider_models.' },
    }),
    run: rpcRun('providers.model.select', args => ({ id: args.id, model: args.model })),
  })
  registerAhTool({
    name: 'ah_provider_configure',
    description: 'Configure (or create) a model profile: provider kind, base URL, model, API key, optional expiry epoch ms.',
    parameters: withDevice({
      id: { type: 'string', required: true, description: 'Profile id, e.g. deepseek-test, openrouter-default.' },
      provider: { type: 'string', enum: ['deepseek', 'openrouter', 'custom'], description: 'Provider kind (default deepseek).' },
      model: { type: 'string', description: 'Model name (defaults to a provider-appropriate model).' },
      base_url: { type: 'string', description: 'Base URL override.' },
      api_key: { type: 'string', required: true, description: 'API key for the profile.' },
      expires_at: { type: 'integer', description: 'Expiry timestamp in epoch ms.' },
    }),
    run: rpcRun('providers.configure', args => clean({ id: args.id, provider: args.provider, model: args.model, base_url: args.base_url, api_key: args.api_key, expires_at: args.expires_at })),
  })
  registerAhTool({
    name: 'ah_provider_test',
    description: 'Test connectivity (and optionally streaming) of a model profile from the device.',
    parameters: withDevice({
      id: { type: 'string', required: true, description: 'Profile id.' },
      stream: { type: 'boolean', description: 'Also test streaming response.' },
    }),
    adbBudget: 90000,
    run: rpcRun('providers.test', args => ({ id: args.id, stream: args.stream === true }), 90000),
  })

  // ---- on-device agent ----
  registerAhTool({
    name: 'ah_agent',
    description: 'Control the autonomous on-device diagnostic agent: start (objective, package, max_steps), status, cancel, pause, resume.',
    parameters: withDevice({
      action: { type: 'string', enum: ['start', 'status', 'cancel', 'pause', 'resume'], required: true, description: 'Agent operation.' },
      objective: { type: 'string', description: 'Investigation goal (required for start).' },
      package: { type: 'string', description: 'Target package (for start).' },
      max_steps: { type: 'integer', description: 'Max reasoning steps (for start; default 100).' },
      run_id: { type: 'string', description: 'Optional run id (for cancel/pause/resume).' },
    }),
    adbBudget: 60000,
    run: function (args, device) {
      const method = 'agent.' + args.action
      let params = args.run_id ? { run_id: args.run_id } : {}
      if (args.action === 'start') {
        params = clean({ objective: args.objective, package: args.package, max_steps: args.max_steps })
        if (!params.objective) return Promise.reject(new Error('agent.start requires objective'))
      }
      return callHarness(device, method, params, 60000).then(r => ({ device: r.device, method, result: r.result }))
    },
  })
  registerAhTool({
    name: 'ah_agent_message',
    description: 'Send a follow-up message to a session agent on the device; may run a continuation investigation (long). Budget defaults to 300s.',
    parameters: withDevice({
      message: { type: 'string', required: true, description: 'Follow-up question or instruction.' },
      session_id: { type: 'string', description: 'Session id; defaults to the active session.' },
      max_steps: { type: 'integer', description: 'Max steps for the continuation run (default 100).' },
      adb_timeout_ms: { type: 'integer', description: 'ADB transport budget in ms (default 300000, max 560000).' },
    }),
    adbBudget: 580000,
    run: function (args, device) {
      const budget = Math.min(Math.max(args.adb_timeout_ms || 300000, 5000), 560000)
      return callHarness(device, 'agent.message', clean({
        message: args.message,
        session_id: args.session_id,
        max_steps: args.max_steps,
      }), budget).then(r => ({ device: r.device, method: 'agent.message', result: r.result }))
    },
  })

  // ---- shells ----
  registerAhTool({
    name: 'ah_shell',
    description: 'Run a shell command on the device as the app user via the harness shell tool. Returns exit_code, stdout, stderr, duration_ms.',
    parameters: withDevice({
      command: { type: 'string', required: true, description: 'Shell command to execute on the device.' },
      timeout_ms: { type: 'integer', description: 'Device-side timeout in ms (default 30000).' },
    }),
    adbBudget: 280000,
    run: function (args, device) {
      const budget = Math.min(Math.max((args.timeout_ms || 30000) + 30000, 10000), 260000)
      return callHarness(device, 'shell.exec', {
        command: args.command,
        timeout_ms: args.timeout_ms || 30000,
      }, budget).then(r => ({ device: r.device, method: 'shell.exec', result: r.result }))
    },
  })
  registerAhTool({
    name: 'ah_root_shell',
    description: 'Run a shell command on the device as root (su) via the harness root shell tool. Returns exit_code, stdout, stderr, duration_ms.',
    parameters: withDevice({
      command: { type: 'string', required: true, description: 'Shell command to execute as root.' },
      timeout_ms: { type: 'integer', description: 'Device-side timeout in ms (default 30000).' },
    }),
    adbBudget: 280000,
    run: function (args, device) {
      const budget = Math.min(Math.max((args.timeout_ms || 30000) + 30000, 10000), 260000)
      return callHarness(device, 'shell.root_exec', {
        command: args.command,
        timeout_ms: args.timeout_ms || 30000,
      }, budget).then(r => ({ device: r.device, method: 'shell.root_exec', result: r.result }))
    },
  })

  // ---- raw escape hatch ----
  registerAhTool({
    name: 'ah_rpc',
    description: 'Invoke any harness RPC method directly (the ahctl rpc command). Use for methods without a dedicated ah_* tool, e.g. harness.* , session.bookmark.add, tools.call.',
    parameters: withDevice({
      method: { type: 'string', required: true, description: 'RPC method name, e.g. harness.status.' },
      params: { type: 'json', description: 'Method parameters object.' },
      session_id: { type: 'string', description: 'Optional session id attached to the request envelope.' },
      adb_timeout_ms: { type: 'integer', description: 'ADB transport budget in ms (default 60000, max 560000).' },
    }),
    adbBudget: 580000,
    run: function (args, device) {
      const budget = Math.min(Math.max(args.adb_timeout_ms || 60000, 5000), 560000)
      return callHarness(device, args.method, args.params || {}, budget, args.session_id).then(r => ({ device: r.device, method: args.method, result: r.result }))
    },
  })

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'ah:native-control',
    order: 910,
    text: 'Android harness control: the ah_* tools speak the Android Harness RPC protocol natively over ADB (no ahctl CLI, no shelling out). '
      + 'Use ah_devices first to discover emulators and pick a target; every ah_* tool accepts device to override the sticky default. '
      + 'Coverage: runtime status/doctor/context, plugins, packages, target/app/daemon control, device diagnostic tools, workflows, skills, '
      + 'artifacts (chunked read or adb pull), snapshots and diff, investigation sessions, model providers, the on-device agent, device shells, '
      + 'and ah_rpc as the raw escape hatch. Prefer these over pwsh adb commands.',
  }), 'ah-bridge: system prompt section')

  console.log('ah-bridge: registered 44 Android-harness tools')
}
