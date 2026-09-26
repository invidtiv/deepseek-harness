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

Select **Add machine**, enter the other installation's displayed environment ID and Tailscale HTTPS URL, and list the project aliases the peer may use. Enter an independently generated pairing secret of at least 32 bytes. Configure the reciprocal peer on the other machine with the same secret. Use a different secret for every pair.

Pairing secrets are written to the local credential store, never returned by configuration reads or embedded in the profile patch. Leave the secret field blank to keep the existing value. Secret writes precede the profile update and are not rolled back if that update fails. An inherited environment credential is read-only and cannot be replaced through this page. Secret changes apply to the next peer request; removing a peer and saving revokes its subsequent requests.

Add as many peers and checkout mappings as the deployment needs. A coordinator with four workers uses four pairs. Worker-to-worker messages pass through the team's coordinator. Each side maps the shared project alias to its own local checkout; files are not synchronized.

<a id="workspace"></a>
## Create a workspace on another machine

Upgrade the plugin on both machines. On the destination, open **Plugins → Environment teams**, enable **Allow workspace browsing and creation in granted directories** for the calling machine, and save. Add an existing parent directory as a checkout alias and include that alias in the caller's allowed workspaces.

In your current Web app, open **Environments** in the sidebar and select the destination machine. Under granted directories, choose **Browse**, navigate to the desired directory, and select **Use as workspace**. To create a directory first, enter a folder name and select **Create folder**. The displayed path belongs to the selected machine.

Registration creates the workspace on the destination. Open that machine's Web app to start its Sessions. A nested workspace needs its own configured alias before it can host a distributed team's lead Session. If discovery or browsing fails, check the destination is running, the peer URL and identity match, and workspace management is granted; then select **Refresh**. No operation is redirected to your local filesystem.

<a id="run"></a>
## Run a team

Start the lead Session on whichever machine should coordinate that team. The Session must use one of that machine's configured checkouts. Ask the agent to use `environment_list` and `environment_team` to create named workers on explicit environments, exchange messages, and update shared tasks. Any paired machine can coordinate its own teams; there is no fixed coordinator setting.

A queued result confirms durable admission, not execution or completion. Each worker appears as an ordinary local Session in its destination Web UI. Exchange Git commits or patches explicitly between checkouts. Interrupt authorized active work separately when removing a grant; removal does not undo already accepted work.

<a id="dev-note"></a>
## Dev Note

The [package reference](../../../packages/experimental/environment-team/README.md) owns protocol, storage, authorization, and limits. Automated loopback tests do not establish reachability of a physical Tailscale fleet.
