"""MuseAgent — hands a DeepSWE task container to Muse over SSH.

Pier runs this on ovh-main (as the runner user). It calls no model: it
publishes the task container name in ``<bench>/current``, drops the task into
``<bench>/queue/<session>.json``, and waits for ``<bench>/queue/<session>.done``
written by the Mac-side relay (bench/deepswe/relay.mjs). The verifier grades
the work Muse committed in the container.
"""

import asyncio
import json
import os
import re
import time
from pathlib import Path

from pier.agents.base import BaseAgent
from pier.environments.base import BaseEnvironment
from pier.models.agent.context import AgentContext
from pier.models.agent.network import NetworkAllowlist

BENCH_DIR = Path(os.environ.get("MUSE_BENCH_DIR", "/srv/muse-bench"))
POLL_SEC = float(os.environ.get("MUSE_BENCH_POLL_SEC", "15"))
TIMEOUT_SEC = float(os.environ.get("MUSE_BENCH_TIMEOUT_SEC", "5400"))


class MuseAgent(BaseAgent):
    @staticmethod
    def name() -> str:
        return "muse"

    def version(self) -> str:
        return "0.1.0"

    def install_spec(self) -> None:
        # Muse is driven through its chat, nothing to install in the image.
        return None

    def network_allowlist(self) -> NetworkAllowlist:
        # The task container stays offline; Muse reaches it over SSH.
        return NetworkAllowlist()

    async def setup(self, environment: BaseEnvironment) -> None:
        pass

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        result = await environment.exec("hostname")
        container = (result.stdout or "").strip()
        if result.return_code != 0 or not container:
            raise RuntimeError(
                f"cannot read task container id: {result.stderr or result.stdout}"
            )

        raw_session = getattr(environment, "session_id", None) or f"muse-{int(time.time())}"
        session = re.sub(r"[^A-Za-z0-9_.-]+", "-", raw_session)
        queue = BENCH_DIR / "queue"
        queue.mkdir(parents=True, exist_ok=True)

        (BENCH_DIR / "current").write_text(container + "\n")
        item = {
            "session": session,
            "container": container,
            "instruction": instruction,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        (queue / f"{session}.json").write_text(json.dumps(item, indent=2) + "\n")
        done_file = queue / f"{session}.done"
        self.logger.info("muse session %s queued for container %s", session, container)

        try:
            deadline = time.monotonic() + TIMEOUT_SEC
            while time.monotonic() < deadline:
                if done_file.exists():
                    payload = json.loads(done_file.read_text() or "{}")
                    self.logger.info(
                        "muse session %s finished: %s", session, payload.get("status")
                    )
                    return
                await asyncio.sleep(POLL_SEC)
            self.logger.warning("muse session %s timed out", session)
            done_file.write_text(
                json.dumps({"status": "timeout", "summary": ""}) + "\n"
            )
        finally:
            try:
                current = BENCH_DIR / "current"
                if current.read_text().strip() == container:
                    current.write_text("")
            except OSError:
                pass
