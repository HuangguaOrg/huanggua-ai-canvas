"""Local compatibility shim for the pinned SDK's Windows resume exporter."""
import os
from pathlib import Path


def extended_path(path: Path) -> Path:
    value = str(path.absolute())
    if os.name != "nt" or value.startswith("\\\\?\\"):
        return path
    return Path("\\\\?\\UNC\\" + value[2:] if value.startswith("\\\\") else "\\\\?\\" + value)


def install_render_paths():
    """Keep FFmpeg/zip intermediates short while retaining atomic file replacement."""
    if os.name != "nt":
        return
    import asyncio
    import shutil
    import tempfile
    from lib.artifacts import rendered_artifact
    if getattr(rendered_artifact, '_huanggua_long_paths', False):
        return
    original = rendered_artifact.commit_rendered_artifact

    async def commit(project_dir, *, key, artifact_path, basis, render, accept):
        staging = Path(tempfile.mkdtemp(prefix='hg-render-'))
        short_output = staging / ('output' + Path(artifact_path).suffix)
        short_workspace = staging / 'work'
        short_workspace.mkdir()
        async def render_short(output, workspace):
            await render(short_output, short_workspace)
            await asyncio.to_thread(shutil.copyfile, short_output, output)
        async def accept_short(output):
            return await accept(short_output)
        try:
            return await original(extended_path(project_dir), key=key, artifact_path=artifact_path,
                                  basis=basis, render=render_short, accept=accept_short)
        finally:
            await asyncio.to_thread(shutil.rmtree, staging, ignore_errors=True)

    rendered_artifact.commit_rendered_artifact = commit
    rendered_artifact._huanggua_long_paths = True


def install_download_paths():
    """Download checkpoints append a UUID and can exceed Windows MAX_PATH."""
    if os.name != 'nt':
        return
    from lib.backends.huanggua_download import VideoDownload
    if getattr(VideoDownload, '_huanggua_long_paths', False):
        return
    original = VideoDownload.__init__

    def initialize(self, output_path, **kwargs):
        original(self, extended_path(output_path), **kwargs)

    VideoDownload.__init__ = initialize
    VideoDownload._huanggua_long_paths = True


def install_resume_paths():
    if os.name != "nt":
        return
    from claude_agent_sdk._internal import session_resume
    if getattr(session_resume, "_huanggua_long_paths", False):
        return
    write_jsonl = session_resume._write_jsonl
    materialize_subkeys = session_resume._materialize_subkeys
    remove_tree = session_resume._rmtree_with_retry

    def write(path, entries):
        return write_jsonl(extended_path(path), entries)

    async def subkeys(store, tmp_base, project_dir, project_key, session_id, timeout_s):
        # Preserve SDK traversal checks. Prefix only trusted absolute roots, so
        # both transcript and metadata sidecar writes support paths > MAX_PATH.
        return await materialize_subkeys(store, extended_path(tmp_base), extended_path(project_dir), project_key, session_id, timeout_s)

    async def cleanup(path, *args, **kwargs):
        # Same SDK-owned temporary directory; only Windows path syntax changes.
        return await remove_tree(extended_path(path), *args, **kwargs)

    session_resume._write_jsonl = write
    session_resume._materialize_subkeys = subkeys
    session_resume._rmtree_with_retry = cleanup
    session_resume._huanggua_long_paths = True
