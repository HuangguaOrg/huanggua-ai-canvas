"""Versioned desktop profile extension; leaves the original engine profile intact."""
import hashlib
import re
from pathlib import Path

GUIDANCE = '''

## 黄瓜客户端：原创输入与脚本阶段
用户要求从创意写故事、剧本，或当前集缺少原文时，先使用 original-story Skill。
无原文并非能力缺失：write-original-story 子智能体可创作正文，再经 edit_source_text
登记到当前集。此原创输入阶段在小说改编/分镜规划之前，不属于手写正式脚本 JSON。
已有故事要拆镜时走 generate_script_plan；generate_episode_script 是正式脚本的提示词编写。
每次先读正式项目状态；客户端本地草稿为空不能作为已有正式故事或脚本不存在的证据。
不推荐不存在的空白脚本工具，不要求原创用户先自己提供原文，不跳出客户端。
'''

PRODUCT_IDENTITY = '''

## 客户端身份与服务入口
你是黄瓜 AI 客户端内的短剧助手。面向用户使用“黄瓜 AI”或“短剧助手”作为产品名称。
制作、素材、对话与配置均在当前客户端内部完成，不引导用户使用旧启动器或原版网站。
模型能力与凭据由黄瓜 AI 账号提供；不能要求用户填写原项目服务的密钥或授权。
底层工具名、文件格式与 Skill 路径保持原有合同，不因产品名称变化而猜测或改写工具名。
'''


DESKTOP_EXECUTION = """

## 桌面执行与素材约定
生成工具在桌面内嵌模式下通常等待批次终态再返回。返回 done=true 或终态结果后直接审核结果，
不再轮询；只有响应明确包含未完成的 batch_id 与轮询提示，才调用 get_generation_batch。
连接中断不等于任务失败，先查询已有批次，不重复提交已成功或在途任务。
素材上传与暂存不依赖所选模型；仅在提交生成时检查模型支持的素材类型、数量与规格。
参考素材缺失时说明哪些素材未使用，使用其余可用素材继续，不把缺失本身当作阻断条件。
聊天视频附件提供的是抽取的关键帧，不包含完整时序或音频。不能仅凭这些帧声称看过完整视频或听过音轨；
需要完整运动、台词或声音分析时如实说明当前输入边界，再使用已有的适用工具或请用户补充信息。
"""


def desktop_profile_text(text: str) -> str:
    # Replace obsolete operational instructions, rather than appending contradictory prose.
    replacements = {
        '请用户在 Web 端「分集」视图里操作。': '客户端尚未提供这些整本源文账本管理入口，请如实说明暂不支持；不要引导到原版网站或直接修改账本。',
        '引导用户到 Web 端「文件」视图下载': '引导用户到客户端「文件」入口下载',
        '只能由用户在 Web 端「文件」视图里操作': '客户端暂未提供对应入口，应明确说明暂不支持',
        '宫格装配由用户在 Web 设置页开关，项目创建后不可经 Agent 改': '读取项目现有宫格设置；客户端尚无切换入口，不可经 Agent 改',
        '由用户在 Web 设置页开关，用户要求改宫格装配时指引其前往设置页操作，并告知开关只影响后续生成': '客户端暂未提供开关，用户要求修改时如实说明暂不支持；设置仅影响后续生成',
        'Web 端剪辑视图的 BGM 轨': '客户端「剪辑」中的背景音乐上传入口',
        '在 Web 端剪辑视图里点该时间线标签旁的菜单，选「删除」': '在客户端「剪辑」选择该时间线并点击「删除」',
        '请在 Web 端下载，下载时填写本机的剪映草稿目录': '请在客户端「剪辑」导出剪映草稿，并填写本机的剪映草稿目录',
        '（Web 端角色卡「衍生」浮层）': '（客户端角色详情的衍生素材操作）',
        '如需重命名或归档，请在 Web 端操作。': '如需重命名或归档，只使用当前客户端实际提供的入口或已有工具；未提供的操作应明确说明暂不支持。',
        '一次调用完成入队并返回 durable batch；按返回的 `poll_after_seconds` 调用 `get_generation_batch`，直到 `done: true` 后再处理结果：': '桌面内嵌工具等待批次终态后返回，直接处理终态结果；仅当返回明确表示尚未完成的 durable batch 时，按 `poll_after_seconds` 调用 `get_generation_batch`，直到 `done: true`：',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    # Remaining Web mentions describe equivalent supported authoring/confirmation flows.
    text = text.replace('Web 端', '客户端').replace('Web 与 Agent', '客户端与 Agent')
    return text


def prepare_profile(engine_root: Path, data: Path, resources: Path) -> Path:
    source = engine_root / 'agent_runtime_profile'
    files = {}
    for path in sorted(source.rglob('*')):
        relative = path.relative_to(source)
        if relative.parts[0] != '.claude' and not (len(relative.parts) == 1 and path.name.startswith('CLAUDE.')):
            continue
        if path.is_symlink() or (hasattr(path, 'is_junction') and path.is_junction()):
            raise ValueError('studio_invalid_profile')
        if path.is_file():
            content = path.read_bytes()
            if path.suffix == ".md":
                # Brand prose while retaining executable tool names, imports and paths.
                content = re.sub(rb"(?<![a-zA-Z0-9_./-])ArcReel(?![a-zA-Z0-9_./-])", b"HuangGuaAI", content)
                content = re.sub(rb"\[(`packages/[^\n`]+`)\]\(https://github\.com/ArcReel/ArcReel/blob/main/[^)]+\)", rb"\1", content)
                content = desktop_profile_text(content.decode('utf-8')).encode('utf-8')
                if path.name.startswith('CLAUDE.'):
                    content += DESKTOP_EXECUTION.encode('utf-8')
            files[relative.as_posix()] = content
    if 'CLAUDE.drama.md' not in files:
        raise ValueError('studio_invalid_profile')
    files['.claude/skills/original-story/SKILL.md'] = (resources / 'original_story.md').read_bytes()
    files['.claude/agents/write-original-story.md'] = (resources / 'write_original_story.md').read_bytes()
    for name in ('CLAUDE.drama.md', '.claude/skills/video-workflow/SKILL.drama.md'):
        files[name] += GUIDANCE.encode('utf-8')
    for name in list(files):
        if name.startswith('CLAUDE.') and name.endswith('.md'):
            files[name] += PRODUCT_IDENTITY.encode('utf-8')
    digest = hashlib.sha256()
    for name, content in sorted(files.items()):
        digest.update(name.encode() + b'\0' + hashlib.sha256(content).digest())
    target = data / 'profiles' / digest.hexdigest()[:24]
    for name, content in files.items():
        path = target / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if not path.exists() or path.read_bytes() != content:
            path.write_bytes(content)
    return target
