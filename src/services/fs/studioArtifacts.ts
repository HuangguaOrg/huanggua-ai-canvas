import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { resolveAssetFolderDirectory } from './assetLibrary';

/** Native bridge downloads only engine-registered, hash-verified artifacts. */
export async function importStudioArtifact(project: string, artifact: string): Promise<string> {
  const directory = await resolveAssetFolderDirectory({ kind: 'global' }, []);
  const path = await invoke<string>('studio_import_artifact', { project, artifact, directory });
  window.dispatchEvent(new Event('studio-assets-imported'));
  return convertFileSrc(path);
}
