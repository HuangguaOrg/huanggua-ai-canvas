"""Disable upstream hosted services before importing the engine application.

Local engine tools, skills and bundled model metadata remain available. Product
accounts and model credentials are supplied exclusively by desktop_bridge.
"""
import os
from copy import copy
from logging.handlers import TimedRotatingFileHandler
from pathlib import Path


BLOCKED_ROUTES = ('/api/v1/market', '/api/v1/official-service', '/api/v1/system/version')


def upstream_route(path: str) -> bool:
    return any(path == prefix or path.startswith(prefix + '/') for prefix in BLOCKED_ROUTES)


async def _noop(*args, **kwargs):
    return None


async def _bundled_catalog(*args, **kwargs):
    from lib.catalog import query as catalog
    catalog.install_synced_data(None)


async def _disabled(*args, **kwargs):
    raise ValueError('studio_upstream_service_disabled')


def _desktop_log_record(record):
    namespace, dot, suffix = record.name.partition(".")
    if namespace.lower() == "arcreel":
        record = copy(record)
        record.name = "HuangGuaAI" + dot + suffix
    return record


def _desktop_log_handler(filename, **options):
    handler = TimedRotatingFileHandler(Path(filename).with_name("HuangGuaAI.log"), **options)
    handler.addFilter(_desktop_log_record)
    return handler


def install_owned_services():
    os.environ['ARCREEL_OFFICIAL_SERVICE_URL'] = ''
    from lib.catalog import official_sync
    from lib.market import sources
    from lib.infra import logging_config
    logging_config.TimedRotatingFileHandler = _desktop_log_handler
    official_sync.start_official_sync = lambda *args, **kwargs: None
    official_sync.stop_official_sync = _noop
    official_sync.load_synced_data = _bundled_catalog
    official_sync.sync_once = _disabled
    sources.seed_official_source = _noop
