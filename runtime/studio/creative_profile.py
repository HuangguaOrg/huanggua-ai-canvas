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
