import { exists } from '@tauri-apps/plugin-fs';
import { localMediaUrlToPath } from '../../utils/mediaUrl';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { resolveAssetFolderDirectory } from './assetLibrary';

/** Native bridge downloads only engine-registered, hash-verified artifacts. */
export async function importStudioArtifact(project: string, artifact: string): Promise<string> {
  const directory = await resolveAssetFolderDirectory({ kind: 'global' }, []);
  const path = await invoke<string>('studio_import_artifact', { project, artifact, directory });
  window.dispatchEvent(new Event('studio-assets-imported'));
  return convertFileSrc(path);
}

/** Cache hits must still refer to an existing copy in the current asset library. */
export async function isStudioArtifactAvailable(url: string): Promise<boolean> {
  const path = localMediaUrlToPath(url);
  if (!path) return false;
  const directory = await resolveAssetFolderDirectory({ kind: 'global' }, []);
  const normalize = (value: string) => {
    const normalized = value.replace(/\\/g, '/').replace(/\/$/, '');
    return /^[a-z]:/i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const normalizedPath = normalize(path);
  if (normalizedPath.slice(0, normalizedPath.lastIndexOf('/')) !== normalize(directory)) return false;
  return exists(path);
}
