"""Account text models use Huanggua's shared Messages API, without brand filters.

Keep the SDK's text, images, thinking and tool exchanges in their native format.
The gateway adapts the wire protocol for each model; generation is never retried.
"""
import hmac
import json
import logging
import re

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

router = APIRouter()
UPSTREAM = "https://huanggua.my/v1/messages"


def messages_request(body):
    # Claude Code adds provider-hosted context management and beta fields.
    # Short-drama tools execute locally: send the common Messages contract,
    # as the previous Responses adapter did, rather than requesting hosted tools.
    payload = {key: body[key] for key in (
        "model", "messages", "max_tokens", "stream", "system", "tool_choice",
        "temperature", "top_p", "top_k", "stop_sequences",
    ) if key in body}
    if "tools" in body:
        payload["tools"] = []
        for tool in body["tools"]:
            if not isinstance(tool, dict) or not isinstance(tool.get("input_schema"), dict) or not tool.get("name"):
                raise ValueError("unsupported hosted tool")
            payload["tools"].append({key: tool[key] for key in ("name", "description", "input_schema") if key in tool})
    return payload


async def project_agent_model(project_name):
    from server.agent_runtime import huanggua_model as engine

    provider_id, model_id = await engine.ConfigResolver(engine.async_session_factory).agent_text_backend(project_name)
    if not engine.is_custom_provider(provider_id):
        raise ValueError("请在项目设置中选择黄瓜 AI 文本模型。")
    async with engine.async_session_factory() as session:
        repo = engine.CustomProviderRepository(session)
        provider = await repo.get_provider(engine.parse_provider_id(provider_id))
        model = await repo.get_model_by_ids(engine.parse_provider_id(provider_id), model_id)
        if provider is None or provider.base_url.rstrip("/") != "https://huanggua.my" or not provider.api_key:
            raise ValueError("项目文本服务不可用，请刷新黄瓜 AI 模型列表。")
        if model is None or not model.is_enabled or model.endpoint != "anthropic-messages":
            raise ValueError("项目文本模型不可用，请刷新列表后重新选择。")
        return engine.ProjectAgentModel(model=model.model_id, api_key=provider.api_key)


def install_text_gateway():
    from server.agent_runtime import huanggua_model
    # The SDK environment and the HTTP bridge must resolve the same project model.
    huanggua_model.project_agent_model = project_agent_model


def error(message, status):
    return JSONResponse({"type": "error", "error": {"type": "api_error", "message": message}}, status_code=status)


def stream_error(message):
    return "event: error\ndata: " + json.dumps({"type": "error", "error": {"type": "api_error", "message": message}}) + "\n\n"


@router.post("/v1/messages")
@router.post("/projects/{project_name}/v1/messages")
async def messages(request: Request, project_name: str | None = None):
    if not request.client or request.client.host not in {"127.0.0.1", "::1"} or request.headers.get("origin"):
        return error("本地文本服务不接受此来源的请求。", 403)
    key = request.headers.get("x-api-key") or request.headers.get("authorization", "").removeprefix("Bearer ")
    if not key:
        return error("缺少文本服务凭据。", 401)
    try:
        body = await request.json()
        if not isinstance(body, dict) or not isinstance(body.get("messages"), list):
            return error("文本请求格式无效。", 400)
        body = messages_request(body)
        if project_name is not None:
            selected = await project_agent_model(project_name)
            if not hmac.compare_digest(key, selected.api_key):
                return error("项目凭据已更新，请重新连接 Agent。", 401)
            body["model"] = selected.model
        if not isinstance(body.get("model"), str) or not body["model"]:
            return error("请选择文本模型。", 400)
        identity = f"Runtime API model selection: {body['model']}. Report this API identifier when asked. The provider's underlying implementation is not independently verified."
        system = body.get("system", "")
        if isinstance(system, str):
            body["system"] = system + "\n\n" + identity
        elif isinstance(system, list):
            body["system"] = [*system, {"type": "text", "text": identity}]
        else:
            return error("文本请求格式无效。", 400)
    except (ValueError, KeyError, TypeError):
        return error("项目文本配置不可用，请刷新模型列表后重试。", 400)

    client = httpx.AsyncClient(timeout=None, trust_env=False, follow_redirects=False)
    try:
        response = await client.send(client.build_request("POST", UPSTREAM, json=body, headers={
            "x-api-key": key, "anthropic-version": "2023-06-01", "User-Agent": "HuangGuaAI-Studio/1.0",
        }), stream=bool(body.get("stream")))
    except httpx.HTTPError:
        await client.aclose()
        return error("文本服务连接失败，本次请求未自动重发。", 502)
    except BaseException:
        await client.aclose()
        raise
    if not response.is_success:
        status = response.status_code if response.is_error else 502
        logging.getLogger(__name__).warning("Text request rejected: HTTP %s, fields=%s, tool_count=%s", status, sorted(body), len(body.get("tools", [])))
        detail = ""
        try:
            await response.aread()
            value = response.json().get("error", {}).get("message", "")
            if isinstance(value, str):
                detail = re.sub(r"sk-[A-Za-z0-9._-]+", "[REDACTED]", value.replace(key, "[REDACTED]"))[:400]
        except (ValueError, AttributeError, httpx.HTTPError):
            pass
        finally:
            await response.aclose()
            await client.aclose()
        return error(f"黄瓜 AI 文本服务返回 HTTP {status}，本次请求未自动重发。" + (f" {detail}" if detail else ""), status)
    if not body.get("stream"):
        try:
            raw = response.json()
            if raw.get("type") != "message" or not isinstance(raw.get("content"), list):
                return error("文本服务返回格式无效。", 502)
            return JSONResponse(raw)
        except (ValueError, AttributeError):
            return error("文本服务返回格式无效。", 502)
        finally:
            await response.aclose()
            await client.aclose()

    async def events():
        frame = []
        try:
            async for line in response.aiter_lines():
                if line:
                    frame.append(line)
                    continue
                data = "\n".join(part[5:].lstrip(" ") for part in frame if part.startswith("data:"))
                event = json.loads(data) if data else {}
                terminal = event.get("type") in {"message_stop", "error"}
                yield ("\n".join(frame) + "\n\n").replace(key, "[REDACTED]")
                frame.clear()
                if terminal:
                    return
            yield stream_error("文本流提前中断，请核对结果后重试。")
        except (httpx.HTTPError, ValueError, AttributeError):
            yield stream_error("文本流中断，本次请求未自动重发。")
        finally:
            await response.aclose()
            await client.aclose()

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})
