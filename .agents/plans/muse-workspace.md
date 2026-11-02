---
title: Muse workspace — a sandboxed machine account Muse works in over Tailscale SSH
status: planned (owner: «давай делать потом», 2026-11-02)
---

# Muse workspace

## Why
Muse's cloud VM (tailnet node `muse`, 100.100.68.99) can SSH into machines of the owner's tailnet.
Instead of reading only chat text, a BB task can tell Muse to work in files: clone a repo, analyse code,
write a plan, implement a formed task, and leave results in a folder the connector collects.

## Shape
- A dedicated non-admin account, never the owner's: either macOS user `muse` on the Mac mini
  (home `/Users/muse`, work dir `/Users/muse/work`) or — preferred — a container/user on `ovh-main`.
- SSH: only Muse's key, in that account's `authorized_keys` with
  `from="100.100.68.99",restrict` (no port/agent/X11 forwarding, no pty unless needed).
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
