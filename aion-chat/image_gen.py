"""
AI 生图模块：支持 Gemini 原生 + OpenAI 兼容双路径
支持 SELFIE（带参考图）和 DRAW（纯文本）两种模式
"""

import base64, time
from pathlib import Path

import httpx

from config import get_key, SETTINGS, UPLOADS_DIR, PUBLIC_DIR

# 参考图位置（用于 SELFIE 模式）
REFERENCE_IMAGE_PATH = PUBLIC_DIR / "生图锚点.jpg"
IMAGE_GEN_MODEL = "gemini-3.1-flash-image-preview"
IMAGE_GEN_TIMEOUT = 120  # 生图超时秒数


async def generate_image(prompt: str, is_selfie: bool = False) -> str | None:
    """
    生成图片，保存到 uploads 目录，返回文件名。
    is_selfie=True 时附带参考图（生图锚点.jpg）。
    优先走自定义 OpenAI 兼容端点，未配置则走 Gemini 原生。
    失败返回 None。
    """
    # ── 检查 OpenAI 兼容自定义端点 ──
    img_url = SETTINGS.get("custom_endpoint_image_url", "").strip()
    img_key = SETTINGS.get("custom_endpoint_image_key", "").strip()
    img_model = SETTINGS.get("custom_endpoint_image_model", "").strip()

    if img_url and img_key and img_model:
        if is_selfie:
            return await _generate_openai_edits(prompt, img_url, img_key, img_model)
        else:
            return await _generate_openai_generations(prompt, img_url, img_key, img_model)

    # ── 回退：Gemini 原生路径 ──
    return await _generate_gemini(prompt, is_selfie)


# ══════════════════════════════════════════════════
#  OpenAI 兼容路径
# ══════════════════════════════════════════════════

async def _generate_openai_generations(prompt: str, base_url: str, api_key: str, model: str) -> str | None:
    """OpenAI /v1/images/generations — 纯文本生图"""
    url = f"{base_url.rstrip('/')}/v1/images/generations"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": model,
        "prompt": prompt,
        "n": 1,
        "size": "1024x1024",
        "response_format": "b64_json",
    }
    try:
        async with httpx.AsyncClient(timeout=IMAGE_GEN_TIMEOUT) as client:
            print(f"[image_gen] OpenAI generations: {prompt[:80]}")
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code != 200:
                body = resp.text[:500]
                print(f"[image_gen] generations API 错误 {resp.status_code}: {body}")
                return None
            data = resp.json()
            b64 = data.get("data", [{}])[0].get("b64_json", "")
            if not b64:
                print("[image_gen] generations 响应中未找到 b64_json")
                return None
            return _save_b64_image(b64, "png")
    except Exception as e:
        print(f"[image_gen] generations 异常: {e}")
        return None


async def _generate_openai_edits(prompt: str, base_url: str, api_key: str, model: str) -> str | None:
    """OpenAI /v1/images/edits — 带参考图的生图（SELFIE 模式）"""
    if not REFERENCE_IMAGE_PATH.exists():
        print(f"[image_gen] 参考图不存在: {REFERENCE_IMAGE_PATH}，降级为 generations")
        return await _generate_openai_generations(prompt, base_url, api_key, model)

    url = f"{base_url.rstrip('/')}/v1/images/edits"
    headers = {"Authorization": f"Bearer {api_key}"}
    ref_bytes = REFERENCE_IMAGE_PATH.read_bytes()

    try:
        async with httpx.AsyncClient(timeout=IMAGE_GEN_TIMEOUT) as client:
            print(f"[image_gen] OpenAI edits: {prompt[:80]}")
            resp = await client.post(
                url,
                data={
                    "prompt": prompt,
                    "model": model,
                    "n": "1",
                    "size": "1024x1024",
                    "response_format": "b64_json",
                },
                files={"image": ("anchor.jpg", ref_bytes, "image/jpeg")},
                headers=headers,
            )
            if resp.status_code != 200:
                body = resp.text[:500]
                print(f"[image_gen] edits API 错误 {resp.status_code}: {body}")
                return None
            data = resp.json()
            b64 = data.get("data", [{}])[0].get("b64_json", "")
            if not b64:
                print("[image_gen] edits 响应中未找到 b64_json")
                return None
            return _save_b64_image(b64, "png")
    except Exception as e:
        print(f"[image_gen] edits 异常: {e}")
        return None


def _save_b64_image(b64_data: str, default_ext: str = "png") -> str | None:
    """将 base64 图片数据解码并保存到 UPLOADS_DIR，返回文件名"""
    try:
        image_bytes = base64.b64decode(b64_data)
        # 从文件头推断扩展名
        ext = default_ext
        if image_bytes[:4] == b'\xff\xd8\xff\xe0' or image_bytes[:4] == b'\xff\xd8\xff\xe1':
            ext = "jpg"
        elif image_bytes[:4] == b'RIFF' and image_bytes[8:12] == b'WEBP':
            ext = "webp"
        elif image_bytes[:8] == b'\x89PNG\r\n\x1a\n':
            ext = "png"

        filename = f"img_gen_{int(time.time() * 1000)}.{ext}"
        filepath = UPLOADS_DIR / filename
        filepath.write_bytes(image_bytes)
        print(f"[image_gen] 图片已保存: {filepath}")
        return filename
    except Exception as e:
        print(f"[image_gen] 保存图片失败: {e}")
        return None


# ══════════════════════════════════════════════════
#  Gemini 原生路径（原有逻辑不变）
# ══════════════════════════════════════════════════

async def _generate_gemini(prompt: str, is_selfie: bool = False) -> str | None:
    """
    调用 Gemini 生图模型生成图片，保存到 uploads 目录，返回文件名。
    is_selfie=True 时自动附带参考图（生图锚点.jpg）。
    失败返回 None。
    """
    api_key = get_key("gemini")
    if not api_key:
        print("[image_gen] 没有 Gemini API Key，无法生图")
        return None

    # 构建请求内容
    parts = [{"text": prompt}]

    # SELFIE 模式：附带参考图
    if is_selfie:
        if REFERENCE_IMAGE_PATH.exists():
            ref_bytes = REFERENCE_IMAGE_PATH.read_bytes()
            ref_b64 = base64.b64encode(ref_bytes).decode("utf-8")
            parts.append({
                "inlineData": {
                    "mimeType": "image/jpeg",
                    "data": ref_b64
                }
            })
            print(f"[image_gen] SELFIE 模式，已附带参考图: {REFERENCE_IMAGE_PATH}")
        else:
            print(f"[image_gen] 参考图不存在: {REFERENCE_IMAGE_PATH}，降级为 DRAW 模式")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{IMAGE_GEN_MODEL}:generateContent?key={api_key}"

    payload = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseModalities": ["IMAGE", "TEXT"],
        },
        "safetySettings": [
            {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
            {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
        ]
    }

    try:
        async with httpx.AsyncClient(timeout=IMAGE_GEN_TIMEOUT) as client:
            print(f"[image_gen] 开始生图... prompt: {prompt[:80]}")
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            data = resp.json()

            # 解析响应，提取图片
            candidates = data.get("candidates", [])
            if not candidates:
                error_msg = data.get("error", {}).get("message", "未知错误")
                print(f"[image_gen] API 返回空 candidates: {error_msg}")
                return None

            content_parts = candidates[0].get("content", {}).get("parts", [])
            image_data = None
            mime_type = "image/png"

            for part in content_parts:
                inline = part.get("inlineData")
                if inline and inline.get("mimeType", "").startswith("image/"):
                    image_data = inline["data"]
                    mime_type = inline["mimeType"]
                    break

            if not image_data:
                print("[image_gen] 响应中未找到图片数据")
                return None

            # 确定文件扩展名
            ext = "png"
            if "jpeg" in mime_type or "jpg" in mime_type:
                ext = "jpg"
            elif "webp" in mime_type:
                ext = "webp"

            # 保存图片
            filename = f"img_gen_{int(time.time() * 1000)}.{ext}"
            filepath = UPLOADS_DIR / filename
            filepath.write_bytes(base64.b64decode(image_data))
            print(f"[image_gen] 图片已保存: {filepath}")
            return filename

    except httpx.HTTPStatusError as e:
        error_body = e.response.text[:500] if e.response else ""
        print(f"[image_gen] API 请求失败 ({e.response.status_code}): {error_body}")
        return None
    except Exception as e:
        print(f"[image_gen] 生图异常: {e}")
        return None
