"""Defer persisted task recovery until the desktop account is authenticated."""
from lib.generation.generation_worker import GenerationWorker


class AccountBoundGenerationWorker(GenerationWorker):
    async def start(self) -> None:
        # Engine lifespan initializes the DB before desktop account configuration.
        # Credentials are memory-only, so starting recovery here would use empty keys.
        return

    async def start_authorized(self) -> None:
        await super().start()
