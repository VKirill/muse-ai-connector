---
title: Muse workspace — a sandboxed machine account Muse works in over Tailscale SSH
status: planned (owner: «давай делать потом», 2026-11-02)
---

# Muse workspace

## Why
Each Muse account has its own cloud VM, and both are in the owner's tailnet (checked 2026-11-03 with `tailscale ip` inside each
Muse and `tailscale status` on the Mac mini): account `main` (VM d517dcc4…) is node `muse-1`, 100.107.209.36; account
`kennethc990-mail-com` (VM 3037844b…) is node `muse`, 100.100.68.99. Muse's tailscale is a TCP proxy outside its container
(no inbound, first connection to each address needs an approval card). Muse can SSH into machines of the owner's tailnet.
Instead of reading only chat text, a BB task can tell Muse to work in files: clone a repo, analyse code,
write a plan, implement a formed task, and leave results in a folder the connector collects.

## Shape
- A dedicated non-admin account, never the owner's: either macOS user `muse` on the Mac mini
  (home `/Users/muse`, work dir `/Users/muse/work`) or — preferred — a container/user on `ovh-main`.
- SSH: only Muse's key, in that account's `authorized_keys` with
  `from="100.107.209.36,100.100.68.99",restrict` (one line per Muse account key) (no port/agent/X11 forwarding, no pty unless needed).
  Remote Login limited to that account (`dseditgroup com.apple.access_ssh` on macOS).
- No access to the owner's home, Chrome profiles, `~/.muse-bridge`, Env Catalog, `bb`, the owner's SSH keys or GitHub token.
- GitHub: public repos clone over https with no key. Private repos: a read-only **deploy key per repo**
  (or a fine-grained token limited to named repos, contents:read) stored only in that account.
  Muse never pushes; changes come back as a patch/branch in `work/<task-id>/out/` and land through a BB writer task.
- Tools in the account: git, node, python, the project's toolchain; disk quota on the work dir.

## Connector side (future task)
- Provider/CLI option `--workspace`: the prompt gets a preamble
  «Work over SSH in `muse@<host>:/…/work/<task-id>/`; put results in `out/`; reply DONE <summary>».
- After the reply the bridge copies `work/<task-id>/out/` back (rsync over the owner's side, read-only) and
  attaches the file list to the BB answer.
- Task kinds: code analysis report, plan, implementation patch, research notes.

## Steps that need the owner's word (ask once for the whole plan)
Creating the OS account / container, enabling Remote Login for it, adding Muse's key, creating deploy keys.

## Muse as a coding writer (owner question 2026-11-03)
Goal: Muse takes a formed task (like a Lane Pilot writer), works autonomously on code, result lands through the usual checks.

- **Route B (preferred): git drop box over Tailscale.** The sandbox account holds only bare repos (`/…/muse/repos/<project>.git`).
  Per task the connector pushes the base commit there as `base/<task>`; Muse (in its own VM, with its own tools) clones from the
  drop box, works, commits, pushes `muse/<task>`. `muse-acp` then fetches `muse/<task>` from the drop box into the BB/Lane Pilot
  worktree (the session `cwd`) and fast-forwards it; Lane Pilot's verification, critique and merge run unchanged. Muse never sees our worktrees.
  SSH for Muse limited to `git-shell` in that account (`command="git-shell -c \"$SSH_ORIGINAL_COMMAND\"",from="100.107.209.36,100.100.68.99",restrict`).
- **Route A (no Tailscale): tool loop over chat.** `muse-acp` asks Muse to answer with structured tool calls (read/write/run),
  executes them through the ACP client's fs/terminal methods inside the worktree under BB's permission mode, and sends results back.
  Safe but ~10 s per step; use only if Route B is refused.
- Trial: low-risk tasks first; `lane_pilot_memory routing_stats` decides if Muse earns medium-risk tasks. Writer chain/provider choice is the owner's Lane Pilot setting.
