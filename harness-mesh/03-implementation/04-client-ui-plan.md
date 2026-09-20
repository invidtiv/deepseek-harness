---
description: "The browser half: the Host API it consumes, the client resource model, and the screens, with cancellation, reconnection, and disposal ownership."
kind: "implementation"
---

# Client UI plan

The browser surface is `packages/client/ui-mesh`. This document states what it renders, which Host methods feed it, and who owns the lifecycle of each live value. The conventions in `packages/client/AGENTS.md` own the mechanics.

## What the earlier draft got wrong

It described a panel that lists peers, follows their sessions, and sends tasks, while the Host API it specified offered **only administration** — node list, pairing, grants, audit. There was nothing to list a peer's sessions, nothing to follow one, nothing to submit a task, and no mutation path for the settings screen. The API now carries the peer-session methods and the settings mutations, and this document consumes exactly those.

## Host methods this surface consumes

| Method | Used by |
|---|---|
| `mesh/status` | This-node block: identity, fingerprint, listener state, bind address, published endpoint, audit health |
| `mesh/nodes` | Peer list |
| `mesh/invite`, `mesh/invitations`, `mesh/approve`, `mesh/deny` | Pairing ceremony |
| `mesh/unpair` | Revoke, with the best-effort remote step reported as a separate outcome |
| `mesh/grants`, `mesh/setGrant` | Grant editor |
| `mesh/audit` | Audit view |
| `mesh/settings`, `mesh/setSettings` | Editable node and listener settings |
| `mesh/peerSessions`, `mesh/peerSessionPage`, `mesh/peerSessionTranscript` | Remote session browsing |
| `mesh/peerSessionFollow` | Live remote session view — a `@Remote({ mode: 'stream' })` method |
| `mesh/submitTask` | "Send to…" from the composer |

## The client resource model

A remote session is a **resource**, not a store, and it is the only part of this surface with a lifecycle longer than a render.

**Ownership.** The panel creates one follow subscription per (node, session) pair inside its `apply` closure and holds it for the panel's lifetime. A second view of the same session joins the existing subscription rather than opening a second stream. Disposal is owned by the panel's Cordis fiber: unloading the plugin aborts every subscription.

**Cancellation.** The subscription holds the `AbortSignal` the stream was opened with. Closing the view, switching sessions, or unloading the plugin aborts it. A server-side end (the session finished, the stream cap closed it, the peer went away) is delivered as a terminal frame with a reason, and is reported in the view rather than retried silently.

**Reconnection.** The stream carries a cursor — the last applied event sequence number. A dropped connection is retried with jittered backoff, resuming from that cursor, for a bounded number of attempts; the view shows the reconnect state, and a failed resume with a gap is reported as a gap rather than papered over. This is required by G5 and is a case (`W-04`).

**Where the data lives.** Frames are business data and belong to the object layer, never to a UI store. The panel declares a store for **view state only**: selected node, selected session, audit filter, dialog mode. The store is created by an exported `createMeshStore()` factory — never a module-level handle — and shared by being passed into registrations inside `apply`.

**Hooks.** Live updates reach components only through a framework hook bound at the registration site. Business components contain no subscription machinery: no `useSyncExternalStore`, no manual subscribe wiring, no mirroring of an external snapshot into local state.

## Screens

### Settings section — "Mesh"

| Block | Contents |
|---|---|
| This node | Display name (editable through `mesh/setSettings`), node id, fingerprint in groups of four, Tailscale name, addresses, published scheme and port, listener state |
| Listener | On/off, topology, bind address or socket path, port, and whether it is currently bound. Changing any of these restarts the row, which the card says plainly |
| Peers | One row per configured node: name, endpoint, state chip, last **successful** contact, allowed operations, and a Manage action |
| Invite | Create invitation, the live invitation with its countdown, and the code shown large enough to read aloud |
| Pending approval | The initiator's display name, **identity fingerprint**, **claimed** proxy identity (labelled as claimed), the SAS, and Approve / Deny. Approve stays disabled until "the codes match" is checked |
| Audit | Durable audit, paged, filterable by direction and outcome. Shows operation, peer, outcome, reason, duration, and hops. Never arguments |
| Diagnostics | Whether `tailscale` was found, whether `serve` is configured for this endpoint, and a prominent banner when the port is Funnel-exposed |

### Sidebar panel — "Mesh"

- Configured nodes with a presence dot and the last successful contact age.
- Per node, its recent sessions, read through `mesh/peerSessions`.
- **Follow** on a remote session opens the live view described above.
- **Send to…** on the local composer routes the typed prompt through `mesh/submitTask`, under the same grant policy the model tools use.

### Command palette

`mesh.pair`, `mesh.invite`, `mesh.nodes`, `mesh.unpair`.

## The pairing dialog

**Responder mode.** Shows the code, the countdown, a copy button, and the exact command line for the other machine — endpoint and `pairingId`, never the code. When the initiator arrives, the dialog becomes the approval view in place: claimed identity, verified identity fingerprint, the SAS, and the comparison instruction.

**Initiator mode.** Prompts for the code with a masked field. It is never placed in a URL, a query string, a log, or component state that outlives the dialog. After the SPAKE2 response it shows the SAS beside the responder's name and fingerprint with the same comparison instruction. On a mismatch it shows a red panel explaining that either the code was wrong or the connection is being intercepted, and offers a **fresh invitation** — never a retry with the same code, because the invitation is burned.

## The mirror rule

A followed remote session is rendered **as a remote view**: distinct header, peer name, peer session id, a "remote" chip, and per-row origin. It is never merged into the local session list, never appended to a local session log, and never presented as local.

The repository rule is that anything reaching a model request must be reconstructable from a session log, and a peer's events were not produced by this node's loop. Writing them into a local log would create a log that cannot be replayed into the same state and would misrepresent authorship. A case (`I-MIRROR-01`) scans the local store after a follow.

## Accessibility and the code display

The code is the one thing a human transcribes. It uses a monospace face at a readable size, exposes its characters as separate accessible elements so a screen reader does not read it as one number, and offers a copy button. It is never placed in an `aria-label` in a shared space, never in a URL, and never in a page title. The countdown changes state visibly at 60 seconds remaining, because a number quietly ticking down is easy to miss.

## Failure presentation

| Situation | What the user sees |
|---|---|
| Peer unreachable | Offline chip with the last successful contact age and a Diagnose action |
| Token revoked by the peer | A **Pair again** action, with the reason stated rather than only the code |
| Refused by policy | The operation named, the reason, and a link to that peer's grant editor |
| Write granted without confinement | A blocking banner naming the missing preset; the write operations stay disabled |
| Version mismatch | A banner naming both protocol versions |
| Port in use | The listener card names the conflicting process when resolvable, otherwise the port and the OS error |
| Funnel exposure | A red banner with the exact `tailscale funnel off` command for that port |

## What the UI deliberately does not do

- No "trust this node automatically". Every pairing needs a code from the other machine's screen.
- No grant presets named "full access". The editor enumerates operations, and every write toggle shows the remote-execution sentence.
- No silent retry of a write operation.
- No rendering of a peer's tool payloads, images, or attachments in the first iteration; the shipped peer tools forward text only, and widening that is a separate decision with its own bounds.
- No identity claim from a proxy used as an authorization input anywhere in the surface.
