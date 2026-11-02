# DeepSWE pilot kit

Runs DeepSWE v1.1 tasks on ovh-main with **Muse** as the agent working over SSH
inside each task container, and reports pass@1.

## How it fits together

```
Mac mini (relay.mjs)                ovh-main
   | musebridge send --json            |  pier run --agent muse_agent:MuseAgent
   |  Muse <--- chat ----------------->|   writes /srv/muse-bench/current
   |    ssh -p 2222 muse@100.73.123.79 |   writes queue/<session>.json
   |      -> muse-task-shell           |   polls queue/<session>.done
   |      -> sudo muse-docker-exec ----|---> docker exec -w /app <container>
   |                                   |   verifier diffs base..HEAD -> reward
```

Muse itself runs on its own tailnet node (`100.100.68.99`) and SSHes in; the
relay on the Mac only turns chat replies into queue results.

## Layout

- `server/setup.sh` — root installer for ovh-main (`--dry-run`, `--uninstall`)
- `server/muse-task-shell` — forced command of Muse's SSH key
- `server/muse-docker-exec` — the only sudo entry: `docker exec` into the
  current task container, `/app`
- `muse_agent.py` — Pier/Harbor agent (`MuseAgent`) that queues tasks
- `relay.mjs` — Mac-side loop over `ssh ovh-main` + `musebridge send --json`
- `run-pilot.sh` — `pier run` wrapper (runs on ovh-main)
- `report.mjs` — `reward.json` files → `report.md` with pass@1

## Install on ovh-main (root)

```sh
MUSE_SSH_PUBKEY="ssh-ed25519 AAAA... muse" bash server/setup.sh
# or: bash server/setup.sh /path/to/muse.pub
# preview first: bash server/setup.sh --dry-run
```

This creates user `muse` (locked password, no groups), installs the two
scripts, writes `/etc/sudoers.d/muse-bench` (the only privilege:
`docker exec` into the current container), prepares `/srv/muse-bench/{queue,runs}`
owned by the runner user (`RUNNER_USER`, default `ubuntu`), and drops an sshd
`Match User muse` block.

## Security model

- Muse's key is valid **only** from `100.100.68.99` and only as a forced
  command: `from="100.100.68.99",restrict,pty,command="muse-task-shell"`.
- `muse` has no shell on the host: every SSH session lands inside
  `docker exec -w /app <current container>`. Bad container names and any
  container that is not the current task are refused; no other docker verb
  exists behind sudo.
- Bench traffic lives in `/srv/muse-bench` owned by the runner user, not `muse`.

## Run a pilot

On ovh-main (Pier + `/srv/muse-bench/deep-swe` checkout, user `ubuntu`):

```sh
N=10 SEED=0 bash bench/deepswe/run-pilot.sh
```

On the Mac mini (signed-in Muse profile via `musebridge`):

```sh
node bench/deepswe/relay.mjs        # keeps polling the queue
node bench/deepswe/relay.mjs --once # single pass
```

After the run:

```sh
ssh ovh-main 'node /path/to/kit/bench/deepswe/report.mjs /srv/muse-bench/runs/<date>'
# or copy the run dir back and run report.mjs locally
```

Muse's rule of engagement (sent by the relay): work autonomously in `/app`,
commit everything with git, reply with a summary ending in `DONE`. A reply
without `DONE` gets "continue" up to `maxContinues` times, then `gave_up`.

## Cleanup

```sh
bash server/setup.sh --uninstall   # removes user, scripts, sudoers, sshd drop-in, /srv/muse-bench
```
