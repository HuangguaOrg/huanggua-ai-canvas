/** Local UI authoring drafts. Studio execution is deliberately not represented as completed. */
export type StudioStage = 'story' | 'assets' | 'shots' | 'video' | 'review' | 'delivery';
export const studioStatusLabels: Record<string, string> = { idle: '待命', running: '执行中', completed: '已完成', error: '执行失败', interrupted: '已停止', closed: '已关闭' };
export interface StudioShot { id: string; title: string; description: string; duration: number }
export interface StudioAttachment { id: string; name: string; kind?: 'image' | 'video'; projectPath?: string }
export interface StudioStagingReference {
  role: string;
  name: string;
  kind: 'image' | 'video';
  format?: string;
  codec?: string | null;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  sizeBytes: number;
  cached?: boolean;
  adjustments?: string[];
}
export interface StudioStagingPrecheck {
  allowed?: boolean;
  needsConfirmation?: boolean;
  kind?: 'image' | 'video';
  model: string;
  targetRatio: string;
  targetResolution: string;
  targetPixelSize?: string | null;
  plannedDuration?: number | null;
  requestDuration?: number | null;
  stagingHost: string;
  ttlHours: number;
  references: StudioStagingReference[];
  blockers: string[];
  warnings: string[];
}
export interface StudioEpisode {
  id: string; name: string; script: string; agentBrief: string; shots: StudioShot[];
  attachments?: StudioAttachment[]; rewriteAnchor?: string;
  models?: Record<string, string>;
  submission?: { requestId: string; content: string; models: Record<string, string>; episodeTitle?: string; sourceText?: string; brief?: string; attachments?: StudioAttachment[]; rewriteAnchor?: string };
}
export interface StudioArtifact { id: string; name: string; kind: 'image' | 'video' | 'audio' | 'text' | 'file'; size: number; url?: string; imported?: boolean; importError?: boolean }
export interface StudioEntry {
  uuid?: string;
  role?: string;
  type?: string;
  subtype?: string;
  rewritable?: boolean;
  content?: Array<{ type: string; text?: string; name?: string; detail?: string; url?: string; is_error?: boolean }>;
}
export interface StudioQuestion { question_id: string; questions: Array<{ question: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }> }
export interface StudioExecution {
  episodeNumber?: number;
  hasOlder?: boolean;
  queued?: Array<{ id: string; state: string; text: string; attachments?: StudioAttachment[] }>;
  sessionId?: string | null;
  supersededBy?: string | null;
  project: string; status: string; entries: StudioEntry[];
  draft?: { content?: Array<{ type: string; text?: string }> } | null;
  questions: StudioQuestion[]; artifacts: StudioArtifact[];
  tasks: Array<{ task_id: string; task_type: string; status: string; resource_id: string; progress?: number }>;
  uncertain?: boolean; error?: string;
}
export interface StudioProject {
  id: string; name: string; updatedAt: number; episodes: StudioEpisode[];
  contentMode?: 'drama' | 'ad'; generationMode?: 'storyboard' | 'reference_video';
  styleTemplateId?: string | null;
  aspectRatio?: string;
  customResolution?: string | null;
}
export interface StudioDraftDocument {
  version: 1; projects: StudioProject[]; projectId: string | null; episodeId: string | null;
}
