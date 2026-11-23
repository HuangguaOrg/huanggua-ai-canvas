/**
 * 短剧 Agent 画面风格模版清单（移植自 黄瓜AI短剧Agent，prompt 由短剧引擎按 style_template_id 内置展开）。
 */
export type StudioStyleCategory = 'live' | 'anim';

export interface StudioStyleTemplate {
  id: string;
  category: StudioStyleCategory;
  name: string;
  tagline: string;
  thumbnail: string;
}

export const DEFAULT_STYLE_TEMPLATE_ID = 'live_premium_drama';

export const STUDIO_STYLE_CATEGORIES: ReadonlyArray<{ id: StudioStyleCategory | 'custom'; label: string }> = [
  { id: 'live', label: 'AI 真人剧' },
  { id: 'anim', label: 'AI 漫剧' },
  { id: 'custom', label: '自定义' },
];

export const STUDIO_STYLE_TEMPLATES: ReadonlyArray<StudioStyleTemplate> = [
  // ===== AI 真人剧 (18) =====
  { id: 'live_cinematic_ancient', category: 'live', name: '精品古装', tagline: '专业打光 · 电视剧质感', thumbnail: '/style-thumbnails/live_cinematic_ancient.webp' },
  { id: 'live_zhang_yimou', category: 'live', name: '张艺谋风格', tagline: '极致用色 · 仪式感', thumbnail: '/style-thumbnails/live_zhang_yimou.webp' },
  { id: 'live_ancient_xianxia', category: 'live', name: '古装仙侠', tagline: '临江仙 · 美白滤镜', thumbnail: '/style-thumbnails/live_ancient_xianxia.webp' },
  { id: 'live_premium_drama', category: 'live', name: '精品短剧', tagline: '真人电视剧 · 大师构图', thumbnail: '/style-thumbnails/live_premium_drama.webp' },
  { id: 'live_cinema', category: 'live', name: '院线电影', tagline: '达芬奇调色 · 电影色调', thumbnail: '/style-thumbnails/live_cinema.webp' },
  { id: 'live_spartan', category: 'live', name: '斯巴达史诗', tagline: '角斗士 · 浓重明暗', thumbnail: '/style-thumbnails/live_spartan.webp' },
  { id: 'live_bladerunner', category: 'live', name: '银翼杀手', tagline: '极简野蛮 · 赛博粒子', thumbnail: '/style-thumbnails/live_bladerunner.webp' },
  { id: 'live_got', category: 'live', name: '权力的游戏', tagline: '冷色史诗 · 权谋', thumbnail: '/style-thumbnails/live_got.webp' },
  { id: 'live_breaking_bad', category: 'live', name: '绝命毒师', tagline: '南美滤镜 · 犯罪美学', thumbnail: '/style-thumbnails/live_breaking_bad.webp' },
  { id: 'live_kdrama', category: 'live', name: '韩剧偶像', tagline: '柔光美颜 · 浪漫偶像', thumbnail: '/style-thumbnails/live_kdrama.webp' },
  { id: 'live_kurosawa', category: 'live', name: '黑泽明', tagline: '黑白高对比 · 人性史诗', thumbnail: '/style-thumbnails/live_kurosawa.webp' },
  { id: 'live_nolan', category: 'live', name: '诺兰', tagline: 'IMAX · 冷蓝灰', thumbnail: '/style-thumbnails/live_nolan.webp' },
  { id: 'live_tarantino', category: 'live', name: '昆汀', tagline: '高对比 · 暴力美学', thumbnail: '/style-thumbnails/live_tarantino.webp' },
  { id: 'live_lynch', category: 'live', name: '大卫林奇', tagline: '平淡日常 · 超现实', thumbnail: '/style-thumbnails/live_lynch.webp' },
  { id: 'live_anderson', category: 'live', name: '韦斯安德森', tagline: '糖果色 · 马卡龙', thumbnail: '/style-thumbnails/live_anderson.webp' },
  { id: 'live_wong', category: 'live', name: '王家卫', tagline: '胶片颗粒 · 东方都市', thumbnail: '/style-thumbnails/live_wong.webp' },
  { id: 'live_shaw', category: 'live', name: '邵氏武侠', tagline: '港式武侠 · 电影感', thumbnail: '/style-thumbnails/live_shaw.webp' },
  { id: 'live_cyberpunk', category: 'live', name: '真人赛博朋克', tagline: '电影质感 · 极致高清', thumbnail: '/style-thumbnails/live_cyberpunk.webp' },
  // ===== AI 漫剧 (18) =====
  { id: 'anim_3d_cg', category: 'anim', name: '3D 游戏 CG', tagline: '影视级 · 虚幻引擎', thumbnail: '/style-thumbnails/anim_3d_cg.webp' },
  { id: 'anim_cn_3d', category: 'anim', name: '国风 3D', tagline: '影视级 · 虚幻引擎', thumbnail: '/style-thumbnails/anim_cn_3d.webp' },
  { id: 'anim_kyoto', category: 'anim', name: '商业动画 京都', tagline: '柔和赛璐珞 · 石立太一', thumbnail: '/style-thumbnails/anim_kyoto.webp' },
  { id: 'anim_arcane', category: 'anim', name: '油画三渲二', tagline: '双城之战 · Arcane', thumbnail: '/style-thumbnails/anim_arcane.webp' },
  { id: 'anim_us_3d', category: 'anim', name: '美式 3D 动画', tagline: '影视级 · 皮克斯', thumbnail: '/style-thumbnails/anim_us_3d.webp' },
  { id: 'anim_ink_wushan', category: 'anim', name: '硬核水墨', tagline: '雾山五行 · 枯笔', thumbnail: '/style-thumbnails/anim_ink_wushan.webp' },
  { id: 'anim_ink_papercut', category: 'anim', name: '水墨剪纸', tagline: '雾山五行 · 重彩', thumbnail: '/style-thumbnails/anim_ink_papercut.webp' },
  { id: 'anim_felt', category: 'anim', name: '羊毛毡', tagline: '定格 · 真实光影', thumbnail: '/style-thumbnails/anim_felt.webp' },
  { id: 'anim_clay', category: 'anim', name: '黏土定格', tagline: '定格 · 大师构图', thumbnail: '/style-thumbnails/anim_clay.webp' },
  { id: 'anim_jp_horror', category: 'anim', name: '日式惊悚', tagline: '低饱和 · 动画美学', thumbnail: '/style-thumbnails/anim_jp_horror.webp' },
  { id: 'anim_kr_webtoon', category: 'anim', name: '韩漫风格', tagline: '半写实 · 浪漫光影', thumbnail: '/style-thumbnails/anim_kr_webtoon.webp' },
  { id: 'anim_zzz', category: 'anim', name: '次世代三渲二', tagline: '绝区零 · 法线调整', thumbnail: '/style-thumbnails/anim_zzz.webp' },
  { id: 'anim_ghibli', category: 'anim', name: '吉卜力', tagline: '宫崎骏 · 温暖质感', thumbnail: '/style-thumbnails/anim_ghibli.webp' },
  { id: 'anim_demon_slayer', category: 'anim', name: '鬼灭 Ufotable', tagline: '粗描边 · 战斗番', thumbnail: '/style-thumbnails/anim_demon_slayer.webp' },
  { id: 'anim_cyberpunk', category: 'anim', name: '动画赛博朋克', tagline: '电影质感 · 高清', thumbnail: '/style-thumbnails/anim_cyberpunk.webp' },
  { id: 'anim_bloodborne', category: 'anim', name: '血源克苏鲁', tagline: '哥特 · 阴冷雾气', thumbnail: '/style-thumbnails/anim_bloodborne.webp' },
  { id: 'anim_itojunji', category: 'anim', name: '伊藤润二', tagline: '惊悚诡异 · 线条锐利', thumbnail: '/style-thumbnails/anim_itojunji.webp' },
  { id: 'anim_90s_retro', category: 'anim', name: '90 年代日漫', tagline: '渡边信一郎 · 神山健治', thumbnail: '/style-thumbnails/anim_90s_retro.webp' },
];

export function findStyleTemplate(id: string | null | undefined): StudioStyleTemplate | undefined {
  return id ? STUDIO_STYLE_TEMPLATES.find(tpl => tpl.id === id) : undefined;
}

export function getStyleTemplatesByCategory(category: StudioStyleCategory): StudioStyleTemplate[] {
  return STUDIO_STYLE_TEMPLATES.filter(tpl => tpl.category === category);
}

export interface StudioStylePickerValue {
  mode: 'template' | 'custom';
  templateId: string | null;
  activeCategory: StudioStyleCategory;
  uploadedFile: File | null;
  uploadedPreview: string | null;
}

export function isStyleDraftComplete(value: StudioStylePickerValue): boolean {
  return value.mode === 'template' ? Boolean(value.templateId) : Boolean(value.uploadedFile ?? value.uploadedPreview);
}

export function hasProjectStyleConfigured(
  remoteProject?: { style_template_id?: string | null; style_image?: string | null; style?: string | null } | null,
  localStyleTemplateId?: string | null,
): boolean {
  if (remoteProject) {
    return Boolean(
      (typeof remoteProject.style_template_id === 'string' && remoteProject.style_template_id.trim())
      || (typeof remoteProject.style_image === 'string' && remoteProject.style_image.trim())
      || (typeof remoteProject.style === 'string' && remoteProject.style.trim()),
    );
  }
  return Boolean(localStyleTemplateId && localStyleTemplateId.trim());
}
