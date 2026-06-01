"""
AI 模型调用：硅基流动 / Gemini 流式 + 多模态消息构建
"""

import json, base64, mimetypes, asyncio, shutil, subprocess, os, re
from pathlib import Path

import httpx
import tempfile

from config import get_key, MODELS, UPLOADS_DIR, CODEX_UPLOADS_DIR, load_worldbook, SETTINGS

# CLI 状态前缀：yield 此前缀的 chunk 会被 _bg_generate 拦截为状态事件，不送入 TTS 和正文
CLI_STATUS_PREFIX = "\x00CLI_STATUS:"

# Gemini CLI 内部思考/工具痕迹清洗：
# Gemini 3 在 agent 模式下处理图片时，可能把内部思考链（image_description / thought / Footnote / 系统指令）
# 混进 assistant 消息正文里。这些片段需要在交付给前端/记忆/TTS 之前剥掉，只保留真正的回复。
_GEMINI_CLI_NOISE_PATTERNS = [
    # <image_description>...</image_description>
    re.compile(r'<image_description>[\s\S]*?</image_description>', re.IGNORECASE),
    # <thought>...</thought> 以及 <step:NN>thought ... </step:NN>thought 这种带后缀的变体
    re.compile(r'<thought>[\s\S]*?</thought>', re.IGNORECASE),
    re.compile(r'<[^<>\n]{0,40}>thought[\s\S]*?</[^<>\n]{0,40}>thought', re.IGNORECASE),
    # Footnote{...} / Footnote {content: ...} 形式的对象序列化
    re.compile(r'Footnote\s*\{[\s\S]*?\}\s*', re.IGNORECASE),
    # 残留的整行系统/agent 指令
    re.compile(r'^.*CRITICAL INSTRUCTION\s*\d+\s*:.*$', re.IGNORECASE | re.MULTILINE),
    re.compile(r'^.*Currently no further tools are needed.*$', re.IGNORECASE | re.MULTILINE),
]
_LEADING_CLI_ROLE_HEADER_RE = re.compile(r'^\s*\[(?:Assistant|Model|AI|Aion)\]\s*', re.IGNORECASE)


def _strip_gemini_cli_noise(text: str) -> str:
    """去除 Gemini CLI agent 模式下泄漏到正文里的思考/工具痕迹。"""
    if not text:
        return text
    cleaned = text
    for pat in _GEMINI_CLI_NOISE_PATTERNS:
        cleaned = pat.sub('', cleaned)
    cleaned = _LEADING_CLI_ROLE_HEADER_RE.sub('', cleaned, count=1)
    # 去除被裁出来后可能剩下的多余空行
    cleaned = re.sub(r'\n{3,}', '\n\n', cleaned)
    return cleaned.strip()


def _extract_gemini_cli_report_error(stderr_text: str) -> tuple[str | None, str | None]:
    """从 Gemini CLI 的临时错误报告里提炼核心错误，并保留报告路径。"""
    if not stderr_text:
        return None, None
    match = re.search(r"Full report available at:\s*(.+?\.json)", stderr_text)
    if not match:
        return None, None
    report_path = Path(match.group(1).strip())
    try:
        payload = json.loads(report_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None, str(report_path)
    err_msg = payload.get("error", {}).get("message")
    cleaned = err_msg.strip() if isinstance(err_msg, str) and err_msg.strip() else None
    return cleaned, str(report_path)


# 流式状态机：噪音块开始 → 闭合 token 列表
# key 是开始触发器（不区分大小写），value 是对应的闭合 token
_NOISE_BLOCK_TRIGGERS = [
    ('<image_description>', '</image_description>'),
    ('<thought>', '</thought>'),
    ('Footnote{', '}'),
    ('Footnote {', '}'),
]
# 行级噪音前缀：整行命中即丢弃
_NOISE_LINE_PREFIXES = (
    'CRITICAL INSTRUCTION',
    'Currently no further tools',
)
# 用于检测 chunk 末尾"可能是噪音开头前缀"的最大窥探长度
_MAX_TRIGGER_LEN = max(len(t[0]) for t in _NOISE_BLOCK_TRIGGERS)


class GeminiCliNoiseFilter:
    """跨 chunk 状态机：检测到噪音标签开始就进入屏蔽态，缓冲后续内容直到对应闭合 token 出现，
    整段噪音直接丢弃。同时识别 'Footnote{' / '<image_description>' 等被切到 chunk 中间的情况。"""

    def __init__(self):
        self.pending = ""        # 暂存可能是触发器开头的尾部碎片
        self.in_block = False    # 当前是否在噪音块内
        self.close_token = ""    # 当前噪音块的闭合 token

    def feed(self, chunk: str) -> str:
        """喂入新 chunk，返回可安全 yield 的干净文本（可能为空）。"""
        if not chunk:
            return ""
        buf = self.pending + chunk
        self.pending = ""
        out_parts: list[str] = []

        i = 0
        n = len(buf)
        while i < n:
            if self.in_block:
                # 在噪音块内：找闭合 token
                idx = buf.find(self.close_token, i)
                if idx == -1:
                    # 闭合还没到，整段丢弃，保留尾部 close_token-1 长度防截断
                    keep = max(0, n - len(self.close_token) + 1)
                    if keep > i:
                        # 中间部分全丢，但保留尾部进 pending 等下次拼接
                        self.pending = buf[keep:]
                    else:
                        self.pending = buf[i:]
                    return "".join(out_parts)
                # 跳过整个噪音块（包括闭合 token）
                i = idx + len(self.close_token)
                self.in_block = False
                self.close_token = ""
                continue

            # 不在噪音块：找最近的触发器
            best_pos = -1
            best_trigger = None
            best_close = None
            lower_buf = buf.lower()
            for trigger, close in _NOISE_BLOCK_TRIGGERS:
                pos = lower_buf.find(trigger.lower(), i)
                if pos != -1 and (best_pos == -1 or pos < best_pos):
                    best_pos = pos
                    best_trigger = trigger
                    best_close = close

            if best_pos == -1:
                # 没有触发器，但末尾可能是触发器的前缀（被切断），保留进 pending
                tail_start = max(i, n - _MAX_TRIGGER_LEN + 1)
                # 检查 buf[tail_start:n] 是否是某个触发器的前缀
                tail = buf[tail_start:].lower()
                is_potential_prefix = False
                for trigger, _ in _NOISE_BLOCK_TRIGGERS:
                    tl = trigger.lower()
                    for k in range(1, min(len(tl), len(tail)) + 1):
                        if tl.startswith(tail[-k:]):
                            is_potential_prefix = True
                            break
                    if is_potential_prefix:
                        break
                if is_potential_prefix and tail_start > i:
                    out_parts.append(buf[i:tail_start])
                    self.pending = buf[tail_start:]
                else:
                    out_parts.append(buf[i:])
                break

            # 输出触发器之前的干净部分
            if best_pos > i:
                out_parts.append(buf[i:best_pos])
            # 进入噪音块
            self.in_block = True
            self.close_token = best_close
            i = best_pos + len(best_trigger)

        cleaned = "".join(out_parts)
        # 行级噪音前缀过滤
        if cleaned and any(p in cleaned for p in _NOISE_LINE_PREFIXES):
            lines = cleaned.split('\n')
            kept = [ln for ln in lines if not any(p in ln for p in _NOISE_LINE_PREFIXES)]
            cleaned = '\n'.join(kept)
        return cleaned

    def flush(self) -> str:
        """流结束时调用，返回 pending 中残留的安全内容。"""
        if self.in_block:
            # 噪音块未闭合，全部丢弃
            self.pending = ""
            self.in_block = False
            return ""
        out = self.pending
        self.pending = ""
        return out


def _resolve_attachment_path(att: str) -> Path:
    """根据附件 URL 路径解析到本地文件"""
    if att.startswith("/cr-uploads/"):
        # /cr-uploads/2026-05-07/xxx.jpg → CODEX_UPLOADS_DIR/2026-05-07/xxx.jpg
        rel = att[len("/cr-uploads/"):]
        return CODEX_UPLOADS_DIR / rel
    elif att.startswith("/uploads/"):
        return UPLOADS_DIR / att[len("/uploads/"):]
    else:
        # fallback: 只取文件名去主 uploads 找
        return UPLOADS_DIR / Path(att).name


def _ensure_gemini_accessible(fpath: Path) -> Path:
    """如果文件在 Connor-Codex/uploads/ 下（Gemini CLI 无权访问），
    则复制一份到 data/uploads/ 并返回新路径；否则原样返回。"""
    try:
        fpath.resolve().relative_to(CODEX_UPLOADS_DIR.resolve())
    except ValueError:
        return fpath  # 不在 CR 目录下，无需处理
    dest = UPLOADS_DIR / fpath.name
    if not dest.exists():
        shutil.copy2(fpath, dest)
    return dest


# ── 多模态消息构建 ────────────────────────────────
def build_multimodal_messages(history: list):
    """将带附件的历史记录转换为 OpenAI 兼容多模态格式"""
    result = []
    for m in history:
        attachments = m.get("attachments", [])
        if isinstance(attachments, str):
            try: attachments = json.loads(attachments) if attachments else []
            except: attachments = []
        if attachments and m["role"] == "user":
            parts = []
            if m["content"]:
                parts.append({"type": "text", "text": m["content"]})
            for att in attachments:
                fpath = _resolve_attachment_path(att)
                if fpath.exists():
                    mime = mimetypes.guess_type(str(fpath))[0] or "image/jpeg"
                    b64 = base64.b64encode(fpath.read_bytes()).decode()
                    if mime.startswith("image/"):
                        parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}})
                    elif mime.startswith("video/"):
                        parts.append({"type": "video_url", "video_url": {"url": f"data:{mime};base64,{b64}"}})
            result.append({"role": m["role"], "content": parts if parts else m["content"]})
        else:
            result.append({"role": m["role"], "content": m["content"]})
    return result


def build_gemini_contents(history: list):
    """将带附件的历史记录转换为 Gemini 格式"""
    contents = []
    for m in history:
        role = "user" if m["role"] == "user" else "model"
        attachments = m.get("attachments", [])
        if isinstance(attachments, str):
            try: attachments = json.loads(attachments) if attachments else []
            except: attachments = []
        parts = []
        if m["content"]:
            parts.append({"text": m["content"]})
        if attachments and m["role"] == "user":
            for att in attachments:
                fpath = _resolve_attachment_path(att)
                if fpath.exists():
                    mime = mimetypes.guess_type(str(fpath))[0] or "image/jpeg"
                    b64 = base64.b64encode(fpath.read_bytes()).decode()
                    parts.append({"inline_data": {"mime_type": mime, "data": b64}})
        contents.append({"role": role, "parts": parts if parts else [{"text": m["content"]}]})
    return contents


# ── 硅基流动 ──────────────────────────────────────
async def call_siliconflow(messages: list, model: str, meta: dict | None = None, temperature: float | None = None, max_tokens: int | None = None):
    url = "https://api.siliconflow.cn/v1/chat/completions"
    headers = {"Authorization": f"Bearer {get_key('siliconflow')}", "Content-Type": "application/json"}
    api_messages = build_multimodal_messages(messages)
    payload = {"model": model, "messages": api_messages, "stream": True,
               "stream_options": {"include_usage": True}}
    if temperature is not None:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                try:
                    err = json.loads(body).get("error", {}).get("message", body.decode())
                except:
                    err = body.decode(errors="replace")[:500]
                yield f"[硅基流动错误 {resp.status_code}] {err}"
                return
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    data = line[6:]
                    if data.strip() == "[DONE]":
                        return
                    try:
                        chunk = json.loads(data)
                        if meta is not None and "usage" in chunk and chunk["usage"]:
                            u = chunk["usage"]
                            meta["prompt_tokens"] = u.get("prompt_tokens", 0)
                            meta["completion_tokens"] = u.get("completion_tokens", 0)
                            meta["total_tokens"] = u.get("total_tokens", 0)
                            meta["raw"] = u  # 保留原始 usage 数据
                        delta = chunk["choices"][0].get("delta", {}) if chunk.get("choices") else {}
                        if "content" in delta and delta["content"]:
                            yield delta["content"]
                    except:
                        pass


# ── Gemini 安全设置（全局关闭内容过滤）─────────────
GEMINI_SAFETY_SETTINGS = [
    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
]

# ── Gemini ────────────────────────────────────────
async def call_gemini(messages: list, model: str, meta: dict | None = None, temperature: float | None = None, max_tokens: int | None = None):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse&key={get_key('gemini')}"
    contents = build_gemini_contents(messages)
    payload = {"contents": contents, "safetySettings": GEMINI_SAFETY_SETTINGS}
    gen_config = {}
    if temperature is not None:
        gen_config["temperature"] = temperature
    if max_tokens is not None:
        gen_config["maxOutputTokens"] = max_tokens
    if gen_config:
        payload["generationConfig"] = gen_config
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("POST", url, json=payload) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                try:
                    err = json.loads(body).get("error", {}).get("message", body.decode())
                except:
                    err = body.decode(errors="replace")[:500]
                yield f"[Gemini错误 {resp.status_code}] {err}"
                return
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    try:
                        chunk = json.loads(line[6:])
                        if meta is not None and "usageMetadata" in chunk:
                            u = chunk["usageMetadata"]
                            meta["prompt_tokens"] = u.get("promptTokenCount", 0)
                            meta["completion_tokens"] = u.get("candidatesTokenCount", 0)
                            meta["total_tokens"] = u.get("totalTokenCount", 0)
                            meta["raw"] = u  # 保留原始 usageMetadata 数据
                        text = chunk.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
                        if text:
                            yield text
                    except:
                        pass

# ── AiPro 中转站 Deepseek ────────────────────────────────────────https://vip.aipro.love
async def call_aipro(messages: list, model: str, meta: dict | None = None, temperature: float | None = None, max_tokens: int | None = None):
    url = "https://api.deepseek.com/v1/chat/completions"	
    headers = {"Authorization": f"Bearer {get_key('aipro')}", "Content-Type": "application/json"}
    api_messages = build_multimodal_messages(messages)
    payload = {"model": model, "messages": api_messages, "stream": True}
    if temperature is not None:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                try:
                    err = json.loads(body).get("error", {}).get("message", body.decode())
                except:
                    err = body.decode(errors="replace")[:500]
                yield f"[中转站错误 {resp.status_code}] {err}"
                return
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    data = line[6:]
                    if data.strip() == "[DONE]":
                        return
                    try:
                        chunk = json.loads(data)
                        if meta is not None and "usage" in chunk and chunk["usage"]:
                            u = chunk["usage"]
                            meta["prompt_tokens"] = u.get("prompt_tokens", 0)
                            meta["completion_tokens"] = u.get("completion_tokens", 0)
                            meta["total_tokens"] = u.get("total_tokens", 0)
                            meta["raw"] = u
                        delta = chunk["choices"][0].get("delta", {}) if chunk.get("choices") else {}
                        if "content" in delta and delta["content"]:
                            yield delta["content"]
                    except:
                        pass

# ── Gemini CLI ────────────────────────────────────
def _find_gemini_script() -> str | None:
    """定位全局安装的 gemini CLI 脚本路径"""
    # 方式1: npm root -g
    try:
        npm_root = subprocess.check_output(["npm", "root", "-g"],
                                           encoding="utf-8", stderr=subprocess.DEVNULL).strip()
        script = Path(npm_root) / "@google" / "gemini-cli" / "bundle" / "gemini.js"
        if script.exists():
            return str(script)
    except Exception:
        pass
    # 方式2: 从 gemini.cmd 位置推导
    try:
        gemini_cmd = shutil.which("gemini")
        if gemini_cmd:
            prefix = Path(gemini_cmd).parent
            script = prefix / "node_modules" / "@google" / "gemini-cli" / "bundle" / "gemini.js"
            if script.exists():
                return str(script)
    except Exception:
        pass
    return None

_GEMINI_SCRIPT: str | None = _find_gemini_script()

def _find_antigravity_binary() -> str | None:
    """定位 Antigravity CLI 的 agy 可执行文件。"""
    agy_bin = shutil.which("agy") or shutil.which("agy.exe")
    if agy_bin:
        return agy_bin
    local_appdata = os.environ.get("LOCALAPPDATA")
    if local_appdata:
        candidate = Path(local_appdata) / "agy" / "bin" / "agy.exe"
        if candidate.exists():
            return str(candidate)
    return None

_ANTIGRAVITY_BINARY: str | None = _find_antigravity_binary()
_ANTIGRAVITY_WORKSPACE: str = str(Path(__file__).parent.parent)

def _summarize_antigravity_log(log_path: Path | None) -> str:
    if not log_path or not log_path.exists():
        return ""
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if "You are not logged into Antigravity" in text:
        return "Antigravity CLI 还没有完成登录。请先在终端运行 agy，选 Google OAuth 完成 CLI 登录，再回到 AionsHome 重试。"
    if "A required privilege is not held by the client" in text and "symlink" in text:
        return "Antigravity CLI 创建项目配置软链接失败。可以用管理员 PowerShell 运行 agy 完成一次初始化，或开启 Windows 开发者模式后再试。"
    if "failed to get model config" in text or "FetchAvailableModels" in text:
        return "Antigravity CLI 没拿到可用模型配置，通常是 CLI 登录状态或网络代理还没通。"
    lines = [ln for ln in text.splitlines() if " E" in ln or " W" in ln or "error" in ln.lower() or "failed" in ln.lower()]
    if lines:
        return lines[-1][-500:]
    return ""

def _ps_single_quote(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"

def _deduplicate_cjk(text: str) -> str:
    """修复 Windows PowerShell 5.1 Start-Transcript 捕获双字节/CJK 字符时
    每个字符被重复两遍的 bug（如 '收收到到' 还原为 '收到收到'）。
    """
    if not text:
        return text
    result = []
    i = 0
    n = len(text)
    while i < n:
        char = text[i]
        if ord(char) > 127:
            if i + 1 < n and text[i + 1] == char:
                result.append(char)
                i += 2
                continue
        result.append(char)
        i += 1
    return "".join(result)

def _extract_antigravity_transcript_output(transcript_path: Path | None) -> str:
    if not transcript_path or not transcript_path.exists():
        return ""
    try:
        text = transcript_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""

    marker = "**********************"
    parts = text.split(marker)
    # Start-Transcript 输出形如：marker + header + marker + command output + marker + footer + marker
    if len(parts) >= 4:
        body = parts[2]
    else:
        body = text

    drop_prefixes = (
        "Windows PowerShell transcript",
        "Start time:",
        "End time:",
        "Username:",
        "RunAs User:",
        "Configuration Name:",
        "Machine:",
        "Host Application:",
        "Process ID:",
        "PSVersion:",
        "PSEdition:",
        "PSCompatibleVersions:",
        "BuildVersion:",
        "CLRVersion:",
        "WSManStackVersion:",
        "PSRemotingProtocolVersion:",
        "SerializationVersion:",
    )
    kept = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped == marker:
            continue
        if any(stripped.startswith(p) for p in drop_prefixes):
            continue
        kept.append(line.rstrip())
    return "\n".join(kept).strip()

def _is_antigravity_auth_prompt(text: str) -> bool:
    lowered = text.lower()
    return (
        "authentication required" in lowered
        or "waiting for authentication" in lowered
        or "authorization code" in lowered
        or "not logged into antigravity" in lowered
        or "accounts.google.com/o/oauth2" in lowered
    )

async def _run_antigravity_print(
    agy_bin: str,
    base_args: list[str],
    prompt: str,
    log_dir: Path,
    *,
    timeout: str,
    prefix: str,
    cwd: str | None = None,
) -> tuple[int | None, str, str]:
    """Run `agy --print` through PowerShell transcript capture.

    On Windows, agy 1.0.0 writes print output to the console buffer instead of
    reliable stdout/stderr pipes, so transcript capture is the least invasive
    bridge for this experimental provider.
    """
    transcript_file = None
    script_file = None
    try:
        fd_tr, transcript_file = tempfile.mkstemp(prefix=f"{prefix}_transcript_", suffix=".txt", dir=log_dir)
        os.close(fd_tr)
        fd_script, script_file = tempfile.mkstemp(prefix=f"run_{prefix}_", suffix=".ps1", dir=log_dir)
        os.close(fd_script)

        prompt_b64 = base64.b64encode(prompt.encode("utf-8")).decode("ascii")
        args_before_prompt = base_args + ["--print"]
        args_literal = "@(" + ",".join(_ps_single_quote(arg) for arg in args_before_prompt) + ",$prompt,'--print-timeout'," + _ps_single_quote(timeout) + ")"
        script_text = (
            "$ErrorActionPreference = 'Continue'\n"
            "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8\n"
            "$OutputEncoding = [System.Text.Encoding]::UTF8\n"
            "$env:NO_COLOR = '1'\n"
            f"$prompt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String({_ps_single_quote(prompt_b64)}))\n"
            f"$agyArgs = {args_literal}\n"
            f"Start-Transcript -Path {_ps_single_quote(transcript_file)} -Force | Out-Null\n"
            f"& {_ps_single_quote(agy_bin)} @agyArgs\n"
            "$exitCode = $LASTEXITCODE\n"
            "Stop-Transcript | Out-Null\n"
            "exit $exitCode\n"
        )
        Path(script_file).write_text(script_text, encoding="utf-8")

        env = {**os.environ, "NO_COLOR": "1"}
        proc = await asyncio.create_subprocess_exec(
            "powershell",
            "-ExecutionPolicy", "Bypass",
            "-File", script_file,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
            cwd=cwd,
            limit=8 * 1024 * 1024,
        )
        stdout, stderr = await proc.communicate()
        out = stdout.decode("utf-8", errors="replace").strip()
        err = stderr.decode("utf-8", errors="replace").strip()
        captured = _extract_antigravity_transcript_output(Path(transcript_file))
        
        # Deduplicate CJK characters to resolve PowerShell transcription duplication
        clean_out = _deduplicate_cjk(out)
        clean_captured = _deduplicate_cjk(captured)
        return proc.returncode, (clean_out or clean_captured).strip(), err
    finally:
        if script_file:
            try:
                Path(script_file).unlink(missing_ok=True)
            except Exception:
                pass

def _build_cli_prompt(messages: list, *, copy_cr_uploads: bool = False) -> str:
    """将 messages 列表拼成供 CLI stdin 使用的完整 prompt。
    图片/音频附件转为本地绝对路径，由 CLI 自行读取文件（避免 base64 超长）。

    优化要点（避免触发 Gemini 3 的 thinking/agent 模式）：
    1. **自动收编伪系统回执对**：项目里历史习惯把人设/能力/记忆等系统配置塞成
       `[user(配置内容)] + [assistant("收到，我会...")]` 的伪对答对。这种结构会让
       Gemini 误以为是 agent 框架的 step-by-step 配置确认，进而开 thinking 模式。
       这里在开头自动识别并合并成一个真正的 [System Instruction] 块，用 # 分节。
    2. 连续同角色消息合并到同一个 [User]/[Assistant] 块，不重复发标签头
       —— 否则会出现连续 `[Assistant]` 这种伪 multi-turn 结构。
    3. 图片/音频附件使用 CLI 原生 @路径 语法（如 @F:/path/to/img.jpg），
       CLI 在输入层直接当多模态附件处理，不走 agent tool-use，不触发思考链。
       路径统一转正斜杠，规避 Windows 反斜杠 \\u \\a \\t 被误读为转义。
    """
    # ── 第 0 步：自动收编开头的"伪系统回执对" ──
    # 模板回执话特征（assistant 内容若以这些前缀开头即视为伪回执）
    _FAKE_ACK_PREFIXES = (
        "收到，我会",
        "好的，需要时我会",
        "好的，我会",
        "明白了，我会",
        "收到，我会自然",
        "收到，我会按照",
    )
    system_chunks: list[str] = []
    consume_until = 0
    i = 0
    while i + 1 < len(messages):
        m1 = messages[i]
        m2 = messages[i + 1]
        if (m1.get("role") == "user"
                and m2.get("role") in ("assistant", "model")):
            ack_text = (m2.get("content", "") or "").strip()
            if any(ack_text.startswith(p) for p in _FAKE_ACK_PREFIXES):
                cfg = (m1.get("content", "") or "").strip()
                if cfg:
                    system_chunks.append(cfg)
                consume_until = i + 2
                i += 2
                continue
        break  # 一旦不匹配就停（只收编开头连续的伪对答）

    real_messages = messages[consume_until:]

    # 第一步：拼出每条消息的"角色 + 内容"，先不加标签
    items: list[tuple[str, str]] = []  # (role, text)

    # 先把收编出来的系统块作为单条 system 消息
    if system_chunks:
        items.append(("system", "\n\n".join(system_chunks)))

    for m in real_messages:
        role = m["role"]
        content = (m.get("content", "") or "").strip()

        # 处理附件：将图片/音频附件解析为本地绝对路径
        # 关键：不能用 `[图片附件] 路径` 这种 tag 风格的元数据标注，Gemini 会识别为
        # agent/工具调用上下文，触发 thinking 模式输出大段内心戏。
        # 必须把图片提示伪装成用户对话的自然延续，让模型走正常对话路径（实测：
        # 用户直接说"帮我读一下 xxx.jpg"完全干净，但机器拼的 `[图片附件] xxx` 必触发思考）。
        att_image_paths: list[str] = []
        att_audio_paths: list[str] = []
        if role == "user":
            attachments = m.get("attachments", [])
            if isinstance(attachments, str):
                try:
                    attachments = json.loads(attachments) if attachments else []
                except Exception:
                    attachments = []
            for att in attachments:
                if isinstance(att, dict):
                    continue  # 跳过 voice/video 等结构化附件（已有 transcript 文本）
                fpath = _resolve_attachment_path(att)
                if copy_cr_uploads:
                    fpath = _ensure_gemini_accessible(fpath)
                if fpath.exists():
                    mime = mimetypes.guess_type(str(fpath))[0] or ""
                    if mime.startswith("image/"):
                        att_image_paths.append(str(fpath.resolve()))
                    elif mime.startswith("audio/"):
                        att_audio_paths.append(str(fpath.resolve()))

        if role in ("assistant", "model"):
            # 历史 assistant 消息防御性清洗：如果数据库里残留了之前未过滤干净的
            # <image_description>/<thought>/Footnote{...}/CRITICAL INSTRUCTION 痕迹，
            # 必须剥掉再喂给 CLI。否则 Gemini 会把它当作"标准回复格式"持续模仿。
            content = _strip_gemini_cli_noise(content)
            unified_role = "assistant"
        elif role == "system":
            unified_role = "system"
        else:
            unified_role = "user"

        text = content
        if att_image_paths:
            # Gemini CLI 原生 @路径 语法：直接在文本末尾追加 @绝对路径，
            # CLI 会在输入层当作多模态附件处理，不经过 agent tool-use，不触发思考链。
            # 路径统一转正斜杠，防止 Windows 反斜杠 \u \a \t 等被误读为转义。
            safe_paths = [p.replace("\\", "/") for p in att_image_paths]
            at_refs = " ".join(f"@{p}" for p in safe_paths)
            text = (text + "\n" + at_refs).strip() if text else at_refs
        if att_audio_paths:
            safe_paths = [p.replace("\\", "/") for p in att_audio_paths]
            at_refs = " ".join(f"@{p}" for p in safe_paths)
            text = (text + "\n" + at_refs).strip() if text else at_refs

        if not text:
            continue
        items.append((unified_role, text))

    # 第二步：连续同角色合并
    merged: list[tuple[str, str]] = []
    for role, text in items:
        if merged and merged[-1][0] == role:
            merged[-1] = (role, merged[-1][1] + "\n\n" + text)
        else:
            merged.append((role, text))

    # 第三步：拼最终 prompt
    parts = []
    for role, text in merged:
        if role == "system":
            parts.append(f"[System Instruction]\n{text}")
        elif role == "assistant":
            parts.append(f"[Assistant]\n{text}")
        else:
            parts.append(f"[User]\n{text}")
    parts.append("[Assistant]")
    return "\n\n".join(parts)

async def _spawn_cli_process(cmd: list[str], prompt: str, env: dict | None = None):
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        stdin=asyncio.subprocess.PIPE,
        env=env,
        limit=8 * 1024 * 1024,
    )
    proc.stdin.write(prompt.encode("utf-8"))
    await proc.stdin.drain()
    proc.stdin.close()
    await proc.stdin.wait_closed()
    return proc

# Gemini CLI tool_name → 中文状态标签映射
_CLI_TOOL_LABELS = {
    "google_web_search": "🔍 联网搜索",
    "web_search":        "🔍 联网搜索",
    "web_fetch":         "🌐 抓取网页",
    "read_file":         "📄 读取文件",
    "read_many_files":   "📄 批量读取文件",
    "write_file":        "📝 写入文件",
    "edit_file":         "✏️ 编辑文件",
    "list_directory":    "📂 列出目录",
    "grep":              "🔎 搜索文本",
    "glob":              "🔎 搜索文件",
    "run_shell_command": "⚙️ 执行命令",
    "shell":             "⚙️ 执行命令",
}

async def call_gemini_cli(messages: list, model: str, meta: dict | None = None,
                          temperature: float | None = None, max_tokens: int | None = None):
    """通过 gemini CLI 子进程流式获取响应（stream-json 模式，支持 token 统计）"""
    prompt = _build_cli_prompt(messages, copy_cr_uploads=True)

    # 构建命令
    node = shutil.which("node") or "node"
    if _GEMINI_SCRIPT:
        cmd = [node, _GEMINI_SCRIPT]
    else:
        gemini_bin = shutil.which("gemini")
        if not gemini_bin:
            yield "[GeminiCLI错误] 未找到 gemini CLI，请先运行 npm install -g @google/gemini-cli"
            return
        cmd = [gemini_bin]

    if model:
        cmd.extend(["-m", model])
    # --skip-trust 跳过目录信任检查；-p " " 触发非交互模式，实际 prompt 通过 stdin 传入
    # -o stream-json 启用 JSONL 流模式，每行一个 JSON 事件：
    #   init / message(user) / tool_use / tool_result / message(assistant,delta) / result(stats)
    # 好处：结构化解析只提取 assistant 正文，tool_use/tool_result 转为状态事件，
    # 不再需要 GeminiCliNoiseFilter 噪音过滤；result 事件自带 token 统计。
    # --approval-mode yolo 允许 CLI 自动执行文件读写和工具调用（如下载图片存盘），
    # plan 模式下非交互模式 write_file 等工具默认被拒绝。
    # 通过前端「允许调用工具」开关控制。
    approval = "yolo" if SETTINGS.get("gemini_cli_tools_enabled", False) else "plan"
    cmd.extend(["--skip-trust", "--approval-mode", approval, "-o", "stream-json", "-p", " "])

    try:
        proc = await _spawn_cli_process(cmd, prompt)

        # 调试日志
        debug_log = None
        if os.environ.get("GEMINI_CLI_DEBUG") == "1":
            from datetime import datetime
            log_dir = Path(__file__).parent / "data" / "cli_debug"
            log_dir.mkdir(parents=True, exist_ok=True)
            ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
            debug_log = log_dir / f"gemini_{ts}.log"
            with open(debug_log, "w", encoding="utf-8") as f:
                f.write("=== PROMPT ===\n")
                f.write(prompt)
                f.write("\n\n=== RAW JSONL ===\n")

        # stream-json 模式：按块读取后再切 JSONL。
        # 不能直接 `async for line in proc.stdout`，否则超长 JSON 行会触发
        # asyncio StreamReader 的行缓冲上限，报：
        # `Separator is not found, and chunk exceed the limit`
        line_buf = ""
        while True:
            chunk = await proc.stdout.read(64 * 1024)
            if not chunk:
                break
            text = chunk.decode("utf-8", errors="replace")
            if not text:
                continue
            if debug_log:
                with open(debug_log, "a", encoding="utf-8") as f:
                    f.write(text)
            line_buf += text
            while "\n" in line_buf:
                line, line_buf = line_buf.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                etype = event.get("type", "")

                if etype == "message":
                    # 只提取 assistant 的增量文本 (delta=true)
                    if event.get("role") == "assistant" and event.get("delta"):
                        content = event.get("content", "")
                        if content:
                            yield content

                elif etype == "tool_use":
                    tool_name = event.get("tool_name", "")
                    params = event.get("parameters", {})
                    label = _CLI_TOOL_LABELS.get(tool_name, f"🔧 {tool_name}")
                    # 构造简洁的状态描述
                    detail = ""
                    if "query" in params:
                        detail = f"：{params['query'][:60]}"
                    elif "command" in params:
                        cmd_str = params["command"]
                        detail = f"：{cmd_str[:60]}{'…' if len(cmd_str) > 60 else ''}"
                    elif "path" in params:
                        detail = f"：{params['path']}"
                    elif "pattern" in params:
                        detail = f"：{params['pattern']}"
                    yield f"{CLI_STATUS_PREFIX}{label}{detail}…"

                elif etype == "tool_result":
                    status = event.get("status", "")
                    tool_id = event.get("tool_id", "")
                    # tool_id 格式如 "google_web_search_1234_0"，提取 tool_name
                    parts = tool_id.rsplit("_", 2)
                    tname = "_".join(parts[:-2]) if len(parts) >= 3 else tool_id
                    label = _CLI_TOOL_LABELS.get(tname, f"🔧 {tname}")
                    if status == "success":
                        yield f"{CLI_STATUS_PREFIX}✅ {label} 完成"
                    else:
                        yield f"{CLI_STATUS_PREFIX}❌ {label} 失败"

                elif etype == "result":
                    # 提取 token 统计
                    stats = event.get("stats", {})
                    if meta is not None and stats:
                        meta["prompt_tokens"] = stats.get("input_tokens", 0)
                        meta["completion_tokens"] = stats.get("output_tokens", 0)
                        meta["total_tokens"] = stats.get("total_tokens", 0)
                        meta["raw"] = stats

                elif etype == "error":
                    err_msg = event.get("message", "") or event.get("error", "")
                    if err_msg:
                        yield f"\n[GeminiCLI错误] {err_msg[:500]}"
        if line_buf.strip():
            try:
                event = json.loads(line_buf.strip())
            except json.JSONDecodeError:
                event = None
            if event and event.get("type") == "error":
                err_msg = event.get("message", "") or event.get("error", "")
                if err_msg:
                    yield f"\n[GeminiCLI错误] {err_msg[:500]}"

        if debug_log:
            with open(debug_log, "a", encoding="utf-8") as f:
                f.write("\n\n=== END ===\n")

        await proc.wait()
        if proc.returncode and proc.returncode != 0:
            stderr_out = await proc.stderr.read()
            err = stderr_out.decode("utf-8", errors="replace").strip()
            report_err, report_path = _extract_gemini_cli_report_error(err)
            if report_err:
                detail = f"\n完整报告：{report_path}" if report_path else ""
                yield f"\n[GeminiCLI错误] {report_err[:500]}{detail}"
            elif err:
                yield f"\n[GeminiCLI错误 code={proc.returncode}] {err[:500]}"

    except FileNotFoundError:
        yield "[GeminiCLI错误] 无法启动 gemini CLI 进程"
    except Exception as e:
        yield f"[GeminiCLI错误] {e}"


# ── Antigravity CLI ───────────────────────────────
async def call_antigravity_cli(messages: list, model: str, meta: dict | None = None,
                               temperature: float | None = None, max_tokens: int | None = None):
    """通过 Antigravity CLI(agy) 非交互 print 模式获取响应。

    当前 agy 1.0.0 暴露的是 --print 文本输出模式，暂未暴露 Gemini CLI 的
    -o stream-json / -m 等价参数，所以这里先作为新增管线接入：保留旧 Gemini CLI，
    Antigravity 的模型选择依赖 agy/Antigravity 自己的 /model 或 settings。
    """
    agy_bin = _find_antigravity_binary()
    if not agy_bin:
        yield "[AntigravityCLI错误] 未找到 agy CLI，请先运行 irm https://antigravity.google/cli/install.ps1 | iex"
        return

    prompt = _build_cli_prompt(messages, copy_cr_uploads=True)
    if model:
        prompt = (
            "[System Instruction]\n"
            f"Aion Chat 本次选择的 Antigravity 目标模型是：{model}。"
            "如果当前 Antigravity CLI 会话支持该模型，请使用它；不要在回复里提及这条内部路由说明。\n\n"
            f"{prompt}"
        )

    # Keep the experimental chat path close to the command that works in a
    # normal user terminal. Adding the workspace can trigger extra AGY project
    # initialization/auth flows, which is useful for coding agents but brittle
    # for casual chat.
    cmd = [
        agy_bin,
        "--log-file",
        "",
    ]
    if SETTINGS.get("gemini_cli_tools_enabled", False):
        cmd.append("--dangerously-skip-permissions")

    log_file = None
    try:
        log_dir = Path(__file__).parent / "data" / "cli_debug"
        log_dir.mkdir(parents=True, exist_ok=True)
        fd_log, log_file = tempfile.mkstemp(prefix="antigravity_", suffix=".log", dir=log_dir)
        os.close(fd_log)
        cmd[cmd.index("--log-file") + 1] = log_file

        yield f"{CLI_STATUS_PREFIX}🔐 检查 Antigravity CLI 登录状态…"
        check_code, check_out, check_err = await _run_antigravity_print(
            agy_bin,
            cmd[1:],
            "请只回复 OK",
            log_dir,
            timeout="2m",
            prefix="antigravity_check",
            cwd=_ANTIGRAVITY_WORKSPACE,
        )
        check_text = "\n".join(part for part in (check_out, check_err) if part)
        if check_code and check_code != 0:
            detail = _summarize_antigravity_log(Path(log_file) if log_file else None) or check_text[:300]
            yield f"[AntigravityCLI错误] 登录预检失败。请先在 PowerShell 里运行 agy 完成 Google OAuth 登录，再回到 AionsHome 重试。{(' ' + detail) if detail else ''}"
            return
        if _is_antigravity_auth_prompt(check_text):
            yield "[AntigravityCLI错误] Antigravity CLI 正在要求重新登录。请先在 PowerShell 里运行 agy，完成 Google OAuth 后再回到 AionsHome 重试。"
            return
        if not check_out:
            detail = _summarize_antigravity_log(Path(log_file) if log_file else None)
            yield f"[AntigravityCLI错误] 登录预检没有收到 AGY 回复{('：' + detail) if detail else ''}"
            return

        yield f"{CLI_STATUS_PREFIX}🚀 Antigravity CLI 正在生成…"
        code, out, err = await _run_antigravity_print(
            agy_bin,
            cmd[1:],
            prompt,
            log_dir,
            timeout="10m",
            prefix="antigravity",
            cwd=_ANTIGRAVITY_WORKSPACE,
        )
        combined = "\n".join(part for part in (out, err) if part)
        if _is_antigravity_auth_prompt(combined):
            yield "[AntigravityCLI错误] Antigravity CLI 又要求重新登录了。请保持同一 Windows 用户会话，在 PowerShell 里运行 agy 完成登录后重试。"
            return
        if code and code != 0:
            detail = err or out or "Antigravity CLI 调用失败"
            yield f"[AntigravityCLI错误 code={code}] {detail[:800]}"
            return
        if err:
            yield f"{CLI_STATUS_PREFIX}⚠️ Antigravity CLI stderr：{err[:120]}…"
        if out:
            yield out
        else:
            detail = _summarize_antigravity_log(Path(log_file) if log_file else None)
            suffix = f"：{detail}" if detail else ""
            yield f"[AntigravityCLI错误] 未收到回复{suffix}"
    except FileNotFoundError:
        yield "[AntigravityCLI错误] 无法启动 agy CLI 进程"
    except Exception as e:
        yield f"[AntigravityCLI错误] {e}"


# ── Codex CLI ─────────────────────────────────────
def _find_codex_script() -> str | None:
    """定位 Codex CLI 脚本路径"""
    # Connor-Codex 项目内的本地安装
    local = Path(__file__).parent.parent / "Connor-Codex" / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
    if local.exists():
        return str(local)
    # 全局安装
    try:
        npm_root = subprocess.check_output(["npm", "root", "-g"],
                                           encoding="utf-8", stderr=subprocess.DEVNULL).strip()
        script = Path(npm_root) / "@openai" / "codex" / "bin" / "codex.js"
        if script.exists():
            return str(script)
    except Exception:
        pass
    return None

_CODEX_SCRIPT: str | None = _find_codex_script()
_CODEX_WORKSPACE: str = str(Path(__file__).parent.parent)

async def call_codex_cli(messages: list, model: str, meta: dict | None = None,
                         temperature: float | None = None, max_tokens: int | None = None):
    """通过 Codex CLI 子进程调用，--json 模式逐行读取 JSONL 事件"""
    prompt = _build_cli_prompt(messages)

    node = shutil.which("node") or "node"
    if not _CODEX_SCRIPT:
        yield "[CodexCLI错误] 未找到 Codex CLI，请检查 Connor-Codex/node_modules/@openai/codex 是否已安装"
        return

    cmd = [node, _CODEX_SCRIPT,
           "--search",
           "exec", "--json",
           "--dangerously-bypass-approvals-and-sandbox",
           "--skip-git-repo-check",
           "--color", "never",
           "-C", _CODEX_WORKSPACE,
           "-"]

    try:
        env = {**os.environ, "NO_COLOR": "1"}
        proc = await _spawn_cli_process(cmd, prompt, env)

        last_agent_text = ""
        line_buf = ""
        while True:
            chunk = await proc.stdout.read(64 * 1024)
            if not chunk:
                break
            line_buf += chunk.decode("utf-8", errors="replace")
            while "\n" in line_buf:
                line, line_buf = line_buf.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue

                etype = event.get("type", "")
                item = event.get("item", {})
                item_type = item.get("type", "")

                # 实时状态事件 → yield 状态标记（不会进入正文/TTS）
                if etype == "item.started":
                    if item_type == "web_search":
                        yield f"{CLI_STATUS_PREFIX}🔍 正在联网搜索…"
                    elif item_type == "command_execution":
                        cmd_str = item.get("command", "")
                        short_cmd = cmd_str[:60] + ("…" if len(cmd_str) > 60 else "") if cmd_str else ""
                        yield f"{CLI_STATUS_PREFIX}⚙️ 正在执行命令{'：' + short_cmd if short_cmd else '…'}"
                elif etype == "item.completed":
                    if item_type == "web_search":
                        query = item.get("query", "")
                        yield f"{CLI_STATUS_PREFIX}🔍 搜索完成{'：' + query[:50] if query else ''}"
                    elif item_type == "command_execution":
                        status = item.get("status", "")
                        label = "✅ 命令完成" if status == "completed" else "❌ 命令失败"
                        yield f"{CLI_STATUS_PREFIX}{label}"
                    elif item_type == "agent_message":
                        last_agent_text = item.get("text", "")
                elif etype == "turn.completed":
                    usage = event.get("usage", {})
                    if meta is not None and usage:
                        meta["prompt_tokens"] = usage.get("input_tokens", 0)
                        meta["completion_tokens"] = usage.get("output_tokens", 0)
                        meta["total_tokens"] = meta["prompt_tokens"] + meta["completion_tokens"]
                        meta["raw"] = usage
        if line_buf.strip():
            try:
                event = json.loads(line_buf.strip())
            except json.JSONDecodeError:
                event = None
            if event:
                etype = event.get("type", "")
                item = event.get("item", {})
                item_type = item.get("type", "")
                if etype == "item.completed" and item_type == "agent_message":
                    last_agent_text = item.get("text", "")
                elif etype == "turn.completed":
                    usage = event.get("usage", {})
                    if meta is not None and usage:
                        meta["prompt_tokens"] = usage.get("input_tokens", 0)
                        meta["completion_tokens"] = usage.get("output_tokens", 0)
                        meta["total_tokens"] = meta["prompt_tokens"] + meta["completion_tokens"]
                        meta["raw"] = usage

        await proc.wait()

        if last_agent_text:
            yield last_agent_text
        elif proc.returncode and proc.returncode != 0:
            stderr_out = await proc.stderr.read()
            err = stderr_out.decode("utf-8", errors="replace").strip()
            yield f"[CodexCLI错误 code={proc.returncode}] {err[:500]}"
        else:
            yield "[CodexCLI错误] 未收到回复"
    except FileNotFoundError:
        yield "[CodexCLI错误] 无法启动 Codex CLI 进程"
    except Exception as e:
        yield f"[CodexCLI错误] {e}"


# ── 非流式调用（收集流式输出） ────────────────────
# ── 自定义 OpenAI 兼容中转站 ──────────────────────
async def call_openai_custom(messages: list, model: str, meta: dict | None = None, temperature: float | None = None, max_tokens: int | None = None):
    base_url = SETTINGS.get("custom_endpoint_url", "").rstrip("/")
    api_key = SETTINGS.get("custom_endpoint_key", "")
    url = f"{base_url}/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    api_messages = build_multimodal_messages(messages)
    payload = {"model": model, "messages": api_messages, "stream": True,
               "stream_options": {"include_usage": True}}
    if temperature is not None:
        payload["temperature"] = temperature
    if max_tokens is not None:
        payload["max_tokens"] = max_tokens
    async with httpx.AsyncClient(timeout=120) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as resp:
            if resp.status_code != 200:
                body = await resp.aread()
                try:
                    err = json.loads(body).get("error", {}).get("message", body.decode())
                except:
                    err = body.decode(errors="replace")[:500]
                yield f"[自定义端点错误 {resp.status_code}] {err}"
                return
            async for line in resp.aiter_lines():
                if line.startswith("data: "):
                    data = line[6:]
                    if data.strip() == "[DONE]":
                        return
                    try:
                        chunk = json.loads(data)
                        if meta is not None and "usage" in chunk and chunk["usage"]:
                            u = chunk["usage"]
                            meta["prompt_tokens"] = u.get("prompt_tokens", 0)
                            meta["completion_tokens"] = u.get("completion_tokens", 0)
                            meta["total_tokens"] = u.get("total_tokens", 0)
                        delta = chunk["choices"][0].get("delta", {}) if chunk.get("choices") else {}
                        if "content" in delta and delta["content"]:
                            yield delta["content"]
                    except:
                        pass


async def simple_ai_call(messages: list, model_key: str, temperature: float | None = None) -> str:
    """收集 stream_ai 的全部 chunk，返回完整文本（自动过滤 CLI_STATUS 状态行）"""
    full_text = ""
    async for chunk in stream_ai(messages, model_key, temperature=temperature):
        if chunk.startswith(CLI_STATUS_PREFIX):
            continue
        full_text += chunk
    return full_text


# ── 统一调度 ──────────────────────────────────────
async def stream_ai(messages: list, model_key: str, meta: dict | None = None, temperature: float | None = None, max_tokens: int | None = None, cancel_event=None):
    normalized = []
    for m in messages:
        nm = dict(m)
        if nm["role"] in ("cam_user", "cam_trigger"):
            nm["role"] = "user"
        elif nm["role"] == "cam_log":
            nm["role"] = "assistant"
        normalized.append(nm)
    cfg = MODELS.get(model_key)
    if not cfg:
        # 动态自定义中转站模型
        if model_key.startswith("自定义/"):
            url = SETTINGS.get("custom_endpoint_url", "").strip()
            key = SETTINGS.get("custom_endpoint_key", "").strip()
            if url and key:
                cfg = {"provider": "openai_custom", "model": model_key[len("自定义/"):]}
        if not cfg:
            yield f"[错误] 未知模型: {model_key}"
            return
    if cfg["provider"] == "siliconflow":
        async for chunk in call_siliconflow(normalized, cfg["model"], meta, temperature, max_tokens):
            if cancel_event and cancel_event.is_set():
                return
            yield chunk
    elif cfg["provider"] == "gemini":
        async for chunk in call_gemini(normalized, cfg["model"], meta, temperature, max_tokens):
            if cancel_event and cancel_event.is_set():
                return
            yield chunk
    elif cfg["provider"] == "aipro":
        async for chunk in call_aipro(normalized, cfg["model"], meta, temperature, max_tokens):
            if cancel_event and cancel_event.is_set():
                return
            yield chunk
    elif cfg["provider"] == "gemini_cli":
        async for chunk in call_gemini_cli(normalized, cfg["model"], meta, temperature, max_tokens):
            if cancel_event and cancel_event.is_set():
                return
            yield chunk
    elif cfg["provider"] == "antigravity_cli":
        async for chunk in call_antigravity_cli(normalized, cfg["model"], meta, temperature, max_tokens):
            if cancel_event and cancel_event.is_set():
                return
            yield chunk
    elif cfg["provider"] == "codex_cli":
        async for chunk in call_codex_cli(normalized, cfg["model"], meta, temperature, max_tokens):
            if cancel_event and cancel_event.is_set():
                return
            yield chunk
    elif cfg["provider"] == "openai_custom":
        async for chunk in call_openai_custom(normalized, cfg["model"], meta, temperature, max_tokens):
            if cancel_event and cancel_event.is_set():
                return
            yield chunk
