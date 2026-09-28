---
description: "Pair Harness installations and map local checkouts from the Plugins page."
kind: "user-guide"
---

# Distributed teams across machines

English | [中文](environment-teams.zh.md)

## Summary

Configure each machine from **Plugins → Environment teams**. Each Harness installation keeps its own Sessions, credentials, model route, and checkout. Machine count, operating systems, hostnames, and checkout paths are deployment choices; the plugin does not encode a particular fleet.

## Table of Contents

- [Install the plugin](#install)
- [Configure each machine](#configure)
- [Pair environments](#pair)
- [Create a workspace on another machine](#workspace)
- [Run a team](#run)
- [Dev Note](#dev-note)

<a id="install"></a>
## Install the plugin

Build this checkout with `pnpm install` and `pnpm run build`. Open DSH Web, select **Plugins → Add plugin**, and enter the absolute path to this checkout's `packages/experimental/environment-team` directory. Install and enable the bundle, then open its **Environment teams** card. No deployment environment variables or source edits are required.

Each installation needs a private DSH home. The plugin keeps its environment identity there and displays the ID on its configuration page. Do not copy the identity file to another machine.

<a id="configure"></a>
## Configure each machine

Set the machine label, local model provider and model, agent preset, sandbox mode, and approval policy. The defaults use Web's standard preset and approval requests. Add a local checkout with a project alias and an existing absolute directory on this machine. Windows and Linux use their own paths for the same alias.

Save the configuration. Values persist in the active profile and survive restart. Saving reloads the team runtime and stops its active workers; queued messages remain durable. A stale form cannot overwrite changes saved by another client. Deployment limits are available in the same page.

For tailnet access, [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve) can forward a private HTTPS endpoint to DSH's loopback server. Configure it for the Web port and retain its HTTPS origin as the peer URL. Browser access through that hostname also requires DSH's ordinary `--trusted-host <hostname>` option and operator authentication. Peer credentials are separate from browser sessions.

<a id="pair"></a>
## Pair environments

Save each machine's reachable Tailscale HTTPS origin in **Plugins → Environment teams** before pairing. The target machine generates a code; the client machine enters it. You do not need to enter a client ID, client URL, or shared secret when generating the code.

1. On the target machine, choose the local directories and permissions to grant, then generate a pairing code. The code expires after 30 minutes by default; its lifetime is configurable in Plugins.
2. Transfer the private `dsh-pair` code to the client machine. Paste it into that machine's pairing form and choose which local directories and permissions to grant back to the target.
3. Accept the code. DSH saves both connections and their credentials automatically. Refresh the machine lists to confirm each machine sees the other; no second code or manual secret is needed.

A code pairs one client only. If completion cannot be confirmed, retry the same code with the same permissions. Generate a new code if an unused one expires. To revoke an established connection, remove the peer and save; code expiration does not disconnect paired machines.

Add as many peers and checkout mappings as the deployment needs. A coordinator with four workers uses four pairs. Worker-to-worker messages pass through the team's coordinator. Each side maps the shared project alias to its own local checkout; files are not synchronized.

<a id="workspace"></a>
## Create a workspace on another machine

Upgrade the plugin on both machines. On the destination, open **Plugins → Environment teams**, enable **Allow workspace browsing and creation in granted directories** for the calling machine, and save. Add an existing parent directory as a checkout alias and include that alias in the caller's allowed workspaces.

In your current Web app, open **Environments** in the sidebar and select the destination machine. Under granted directories, choose **Browse**, navigate to the desired directory, and select **Use as workspace**. To create a directory first, enter a folder name and select **Create folder**. The displayed path belongs to the selected machine.

Registration creates the workspace on the destination. A nested workspace needs its own configured alias before it can host a distributed team's lead Session. If discovery or browsing fails, check the destination is running, the peer URL and identity match, and workspace management is granted; then select **Refresh**. No operation is redirected to your local filesystem.

To use Sessions from this Web app, enable **Allow workspace session access** for the calling machine in the destination's Plugins configuration. Select **Open sessions** on the registered workspace, then **New session** or open an existing Session. Send text or stop active work from that panel. Assistant text appears while the reply is being generated, including replies started through the destination's Web app. After a connection failure, the last view remains visible; reconnect restores saved messages and any unfinished reply. If a send was not acknowledged, **Retry message** reuses its submission identity.

Use **Remote sessions** in the sidebar to return to remote work, then select a recent workspace. Switching workspaces or Sessions keeps each conversation's draft, uploaded attachment receipts, uncertain-message retry identity, and last view in browser memory, scoped to its machine, workspace, and Session. On return, DSH refreshes the conversation from the owning machine without automatically resending a message. Reloading the browser clears local drafts and navigation memory.

Select **Earlier messages** to read the preceding page of the selected conversation. The page stays fixed as new replies arrive; select **Return to live conversation** to see current messages. Switching workspaces or Sessions also returns to the live view. These actions keep your draft unchanged. Page size follows the message limit configured in Plugins. If the destination does not support history paging, update its plugin before retrying.

Sessions run with the destination's credentials and ordinary Web defaults. Their logs and files remain there. Upgrade both installations for live text. The panel shows committed tool details and errors; attachments, approval responses, and terminals require their separate destination grants. Refresh, heartbeat, idle timeout, and message limits are configurable in Plugins. Closing the panel disconnects its view without stopping the Session. Workspace browsing permission alone does not grant Session access.

<a id="run"></a>
## Run a team

Start the lead Session on whichever machine should coordinate that team. The Session must use one of that machine's configured checkouts. Ask the agent to use `environment_list` and `environment_team` to create named workers on explicit environments, exchange messages, and update shared tasks. Any paired machine can coordinate its own teams; there is no fixed coordinator setting.

A queued result confirms durable admission, not execution or completion. Each worker appears as an ordinary local Session in its destination Web UI. Exchange Git commits or patches explicitly between checkouts. Interrupt authorized active work separately when removing a grant; removal does not undo already accepted work.

<a id="dev-note"></a>
## Dev Note

The [package reference](../../../packages/experimental/environment-team/README.md) owns protocol, storage, authorization, and limits. Automated loopback tests do not establish reachability of a physical Tailscale fleet.
