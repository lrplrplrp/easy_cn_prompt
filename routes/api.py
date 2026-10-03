"""HTTP API：/easy_cn_prompt/*（见开发文档 §8）。"""

from __future__ import annotations

import re
import time

from aiohttp import web

from ..lexicon.db import CATEGORY_META, get_lexicon
from ..lexicon.db import _has_cjk
from ..nodes.cn_prompt_node import parse_weight_syntax

ROUTES = web.RouteTableDef()


@ROUTES.get("/easy_cn_prompt/status")
async def status(request: web.Request) -> web.Response:
    lex = get_lexicon()
    from ..lexicon import custom_dict

    return web.json_response({
        "ok": True,
        "lexicon": lex.stats(),
        "custom_count": custom_dict.count(),
        "categories": {str(k): v for k, v in CATEGORY_META.items()},
        "translate_backends": [],  # 二期填充，前端据此动态渲染
        "version": "0.20.0-demo",
    })


@ROUTES.get("/easy_cn_prompt/search")
async def search(request: web.Request) -> web.Response:
    q = request.query.get("q", "")
    try:
        limit = max(1, min(100, int(request.query.get("limit", 30))))
    except ValueError:
        limit = 30

    t0 = time.perf_counter()
    results = get_lexicon().search(q, limit=limit)
    elapsed = (time.perf_counter() - t0) * 1000.0

    return web.json_response({
        "query": q,
        "elapsed_ms": round(elapsed, 2),
        "results": results,
    })


@ROUTES.get("/easy_cn_prompt/lookup")
async def lookup(request: web.Request) -> web.Response:
    lex = get_lexicon()
    en = request.query.get("en")
    cn = request.query.get("cn")

    if en:
        item = lex.lookup_en(en)
        return web.json_response({"results": [item] if item else []})
    if cn:
        return web.json_response({"results": lex.lookup_cn(cn)})
    return web.json_response({"results": []})


@ROUTES.get("/easy_cn_prompt/categories")
async def categories(request: web.Request) -> web.Response:
    return web.json_response({str(k): v for k, v in CATEGORY_META.items()})


def _split_segments(text: str) -> list[str]:
    """按中英文逗号 / 换行 / 分号拆段，并丢掉空段。"""
    import re

    parts = re.split(r"[,，;；\n]+", text or "")
    return [p.strip() for p in parts if p.strip()]


@ROUTES.post("/easy_cn_prompt/convert")
async def convert(request: web.Request) -> web.Response:
    """把一段普通提示词批量解析成词块。

    请求：{"text": "1girl, 长发, smile", "allow_unlisted": true}
    返回：{"items": [{"raw","matched","en","cn","category","source","unlisted"}...]}

    匹配优先级：英文精确 → 中文精确 → 中文子串最佳一条 → 未收录
    """
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    text = body.get("text", "")
    allow_unlisted = bool(body.get("allow_unlisted", True))
    base_model = body.get("base_model", "")
    anima = "anima" in str(base_model).lower()
    lex = get_lexicon()

    items: list[dict] = []
    for seg in _split_segments(text):
        # 先剥离 A1111 权重语法：`(tag:1.2)` -> ("tag", 1.2)
        bare, weight = parse_weight_syntax(seg)
        if not bare:
            continue

        hit = lex.lookup_en(bare)
        if hit is None:
            cn_hits = lex.lookup_cn(bare)
            hit = cn_hits[0] if cn_hits else None
        if hit is None and _has_cjk(bare):
            # 中文整句：退而求其次，用搜索的第一条
            sub = lex.search(bare, limit=1)
            hit = sub[0] if sub else None

        if hit is not None:
            cat = hit.get("category", 0)
            items.append({
                "raw": seg,
                "matched": True,
                "en": hit["en"],
                # Anima 基础模型：画师标签加 @ 前缀（词块里存的就是带回的显示值）
                "display_en": ("@" + hit["en"]) if (anima and cat == 1 and not hit["en"].startswith("@")) else hit["en"],
                "cn": hit["cn"] if hit.get("has_cn") else "",
                "category": cat,
                "source": hit.get("source", "builtin"),
                "unlisted": False,
                "weight": weight,
            })
        elif allow_unlisted:
            items.append({
                "raw": seg,
                "matched": False,
                "en": bare,
                "display_en": bare,
                "cn": bare,
                # 未收录 → 待确认(21)，供前端「分类待确认」按钮批量处理
                "category": 21,
                # 未收录词不在自定义词库里，别标成 custom
                "source": "builtin",
                "unlisted": True,
                "weight": weight,
            })

    return web.json_response({
        "ok": True,
        "items": items,
        "total": len(items),
        "matched": sum(1 for i in items if i["matched"]),
    })


# ---------------- 自定义词库（一期：保存 / 列表 / 删除） ----------------

@ROUTES.post("/easy_cn_prompt/custom/save")
async def custom_save(request: web.Request) -> web.Response:
    from ..lexicon import custom_dict

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    res = custom_dict.save(
        en=body.get("en", ""),
        cn=body.get("cn", ""),
        category=body.get("category", 0),
        note=body.get("note", ""),
        # 前端「保存到词库」子菜单可指定目标词库（id 或名称）
        dict_id=int(body.get("dict_id") or 0),
        dict_name=body.get("dict_name", "") or "",
    )
    return web.json_response(res, status=200 if res.get("ok") else 400)


@ROUTES.get("/easy_cn_prompt/custom/list")
async def custom_list(request: web.Request) -> web.Response:
    from ..lexicon import custom_dict

    return web.json_response({"results": custom_dict.list_all()})


@ROUTES.post("/easy_cn_prompt/custom/delete")
async def custom_delete(request: web.Request) -> web.Response:
    from ..lexicon import custom_dict

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    res = custom_dict.delete(en=body.get("en", ""), cn=body.get("cn", ""))
    return web.json_response(res, status=200 if res.get("ok") else 400)


# ---------------- 翻译（Hy-MT2） ----------------

@ROUTES.get("/easy_cn_prompt/translate/models")
async def translate_models(request: web.Request) -> web.Response:
    """列出可用的翻译模型（扫描 models/easy_cn_prompt/*.gguf）。"""
    from ..translate import base as tb

    models = tb.list_models()
    return web.json_response({
        "ok": True,
        "models": models,
        "dir": tb.models_dir(),
        # 一个都没有时前端给出下载提示
        "hint": ("把 Hy-MT2 的 gguf 放进上面这个目录即可，例如 "
                 "Hy-MT2-1.8B-Q4_K_M.gguf（约 1.1GB）"),
    })


@ROUTES.post("/easy_cn_prompt/translate")
async def translate(request: web.Request) -> web.Response:
    """批量翻译未收录词块。

    方向**按内容自动判定**（不再由调用方指定）：
      - 含中文  → 译成英文（最终输出必须是英文标签）
      - 纯英文  → 译成中文（只用来生成中文显示名，输出仍保留原英文）

    请求：{"items": ["赛博狐狸", "cyber fox"], "model": "xxx.gguf"}
    返回：{"ok": true, "results": [
             {"text", "translation", "direction", "en", "cn", "lexicon_hit"}, ...]}
    """
    import anyio

    from ..translate import base as tb

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    items = body.get("items") or []
    if not isinstance(items, list) or not items:
        return web.json_response({"ok": False, "error": "items 不能为空"}, status=400)

    model_name = body.get("model", "")
    tr = tb.LlamaGgufTranslator(model_name)
    if not tr.available():
        return web.json_response({
            "ok": False,
            "error": f"找不到翻译模型：{model_name or '(未选择)'}",
            "models_dir": tb.models_dir(),
        }, status=400)

    lex = get_lexicon()
    results: list[dict] = []
    errors: list[str] = []

    for raw in items[:200]:
        text = str(raw).strip()
        if not text:
            continue

        # ★ 去掉权重语法再翻译 ★
        # 前端会把权重拼进显示文本（"双马尾 (1.2)"），
        # 那是给人看的，不该送去翻译 —— 否则模型会把 "(1.2)" 也译了。
        text = tb.strip_weight(text) or text

        # 中英混合 → 译成中文（取英文部分）；
        # 纯中文 → 译成英文；纯英文 → 译成中文
        to_english = tb.detect_direction(text)
        direction = "zh2en" if to_english else "en2zh"

        # ★ 中英混合时，先抽出英文部分作为翻译输入 ★
        # 例："1girl 少女" → 拿 "1girl" 去译，得到 "1girl / 少女"，
        # 而不是把整串当中文句子译成英文。
        if tb.is_mixed(text):
            en_part = " ".join(
                tok for tok in re.split(r"[,\s，、；;]+", text)
                if re.search(r"[A-Za-z]", tok)
            ).strip()
            if en_part:
                text = en_part

        # ★ 第一优先：先查词库 ★
        # 词库里有官方中英对照（如 "双马尾" ↔ twintails），
        # 比模型翻译准得多，也快得多。命中就不必再跑模型。
        #
        # ⚠️ 匹配方式按方向区分（需求方明确）：
        #   中文→英文：**允许模糊**（search）—— 中文输入常是整句/口语，
        #             模糊搜索能帮忙找到对应标签
        #   英文→中文：**必须完全匹配** —— 英文若用子串匹配，
        #             "hair" 会命中 "long_hair"，直接曲解词义
        if to_english:
            hits = lex.lookup_cn(text) or lex.search(text, limit=1)
        else:
            one = lex.lookup_en(text)          # ★ 完全匹配，不再 search 兜底
            hits = [one] if one else []

        # ★ 先用**纯英文部分**查一次词库/质量词 ★
        #
        # 前端送来的是「中文名 英文标签」（如 "杰作 masterpiece"），
        # 含中文 → 会被判定为 zh2en 方向并拿**整串**去查词库 —— 查不到。
        # 但英文部分本身可能就是内置质量词（masterpiece）或已有官方标签，
        # 这类词**根本不需要翻译**，直接查出来返回即可。
        en_only = text
        for tok in text.replace("，", ",").split():
            tok = tok.strip()
            if tok and not tb.has_cjk(tok):
                en_only = tok          # 取最后一个无 CJK 的 token（即英文标签）
                break
        if en_only != text:
            pre = lex.lookup_en(en_only)
            if pre:
                results.append({
                    "text": text,
                    "translation": pre["en"],
                    "direction": "pre-matched",
                    "en": pre["en"],
                    "cn": pre["cn"] or text,
                    "category": pre.get("category", 5),
                    "lexicon_hit": True,
                    "ok": True,
                })
                continue

        if hits:
            found = hits[0]
            results.append({
                "text": text,
                "translation": found["en"],
                "direction": direction,
                "en": found["en"],
                "cn": found["cn"] or text,
                "category": found.get("category", 0),   # ★ 命中词库时带回分类
                "lexicon_hit": True,
                "ok": True,
            })
            continue

        # ★ 第二优先：词库没有，才动模型 ★
        try:
            # 子进程推理会阻塞，丢到线程池，别卡住 aiohttp 事件循环
            out = await anyio.to_thread.run_sync(
                lambda t=text, d=to_english: tb.translate_cached(tr, t, d)
            )
        except Exception as e:  # noqa: BLE001
            errors.append(f"{text}: {e}")
            results.append({
                "text": text, "translation": "", "direction": direction,
                "en": text, "cn": "", "lexicon_hit": False,
                "ok": False, "error": str(e),
            })
            continue

        en, cn = text, ""
        hit = False

        if to_english:
            # 中文 → 英文：译文就是新的英文输出；中文显示名沿用用户原文
            en = out or text
            cn = text
        else:
            # 英文 → 中文：输出仍是原英文；译文作为中文显示名
            cn = out or ""
            # 拿译出来的中文**再查一次**词库，命中就用正式标签覆盖。
            # （例：把 "kitty ears" 译成「猫耳」→ 词库命中 cat_ears）
            #
            # ⚠️ 这里属"英文→中文"路径 → 按需求方要求用**完全匹配**。
            # 若用模糊搜索，译文「猫」会命中「猫耳」等词，曲解原意。
            if cn:
                found = None
                try:
                    more = lex.lookup_cn(cn)      # ★ 完全匹配，不 search 兜底
                    found = more[0] if more else None
                except Exception:  # noqa: BLE001
                    found = None
                if found:
                    en = found["en"]
                    cn = found["cn"] or cn
                    hit = True

        results.append({
            "text": text,
            "translation": out,
            "direction": direction,
            "en": en,
            "cn": cn,
            "lexicon_hit": hit,
            "ok": True,
        })

    return web.json_response({
        "ok": True,
        "results": results,
        "ok_count": sum(1 for r in results if r["ok"]),
        "fail_count": len(errors),
        "errors": errors[:5],
    })


@ROUTES.get("/easy_cn_prompt/translate/status")
async def translate_status(request: web.Request) -> web.Response:
    """翻译子系统状态：模型是否就绪、后端类型。"""
    from ..translate import base as tb

    models = tb.list_models()
    return web.json_response({
        "ok": True,
        "ready": bool(models),
        "model_count": len(models),
        "models_dir": tb.models_dir(),
    })


# ---------------- 词库管理 ----------------

@ROUTES.get("/easy_cn_prompt/dicts")
async def dicts_list(request: web.Request) -> web.Response:
    """列出全部词库（含内置），按顺序排。"""
    from ..lexicon import custom_dict

    return web.json_response({"ok": True, "dicts": custom_dict.list_dicts()})


@ROUTES.post("/easy_cn_prompt/dicts/create")
async def dicts_create(request: web.Request) -> web.Response:
    from ..lexicon import custom_dict

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    res = custom_dict.create_dict(body.get("name", ""))
    return web.json_response(res, status=200 if res.get("ok") else 400)


@ROUTES.post("/easy_cn_prompt/dicts/rename")
async def dicts_rename(request: web.Request) -> web.Response:
    from ..lexicon import custom_dict

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    res = custom_dict.rename_dict(int(body.get("id", -1)), body.get("name", ""))
    return web.json_response(res, status=200 if res.get("ok") else 400)


@ROUTES.post("/easy_cn_prompt/dicts/toggle")
async def dicts_toggle(request: web.Request) -> web.Response:
    from ..lexicon import custom_dict

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    res = custom_dict.set_enabled(int(body.get("id", -1)), bool(body.get("enabled", True)))
    return web.json_response(res, status=200 if res.get("ok") else 400)


@ROUTES.post("/easy_cn_prompt/dicts/reorder")
async def dicts_reorder(request: web.Request) -> web.Response:
    from ..lexicon import custom_dict

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    res = custom_dict.reorder_dicts(body.get("order") or [])
    return web.json_response(res, status=200 if res.get("ok") else 400)


@ROUTES.post("/easy_cn_prompt/dicts/delete")
async def dicts_delete(request: web.Request) -> web.Response:
    from ..lexicon import custom_dict

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    res = custom_dict.delete_dict(int(body.get("id", -1)))
    return web.json_response(res, status=200 if res.get("ok") else 400)


@ROUTES.get("/easy_cn_prompt/dicts/export")
async def dicts_export(request: web.Request) -> web.Response:
    """导出词库为 JSON 文件下载。"""
    from ..lexicon import custom_dict

    try:
        did = int(request.query.get("id", "1"))
        fmt = (request.query.get("format") or "json").lower()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "参数错误"}, status=400)

    data = custom_dict.export_dict(did)
    if not data.get("ok"):
        return web.json_response(data, status=400)

    if fmt == "csv":
        lines = ["en,cn,category"]
        for t in data["tags"]:
            en = str(t["en"]).replace(",", " ")
            cn = str(t["cn"]).replace(",", " ")
            lines.append(f"{en},{cn},{t.get('category', 0)}")
        body = "\n".join(lines).encode("utf-8")
        ctype = "text/csv"
        ext = "csv"
    else:
        import json as _json

        body = _json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        ctype = "application/json"
        ext = "json"

    safe = "".join(ch for ch in str(data["name"]) if ch not in '\\/:*?"<>|') or "dict"
    # ⚠️ 不要把 charset 写进 content_type —— aiohttp 会直接抛
    # ValueError("charset must not be in content_type argument")。
    # charset 用单独的 charset 参数指定。
    return web.Response(
        body=body,
        content_type=ctype,
        charset="utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe}.{ext}"'},
    )


@ROUTES.post("/easy_cn_prompt/dicts/import")
async def dicts_import(request: web.Request) -> web.Response:
    """导入词库。

    接受：
      · JSON 正文 {"name": ..., "tags": [...]}（或直接文件内容字符串）
      · CSV 文本
    也支持 multipart 上传（字段名 file）。
    """
    import json as _json

    from ..lexicon import custom_dict

    target_name = ""
    raw_text = ""
    payload = None

    ctype = (request.headers.get("Content-Type") or "").lower()
    if "multipart/form-data" in ctype:
        try:
            post = await request.post()
            f = post.get("file")
            if f is not None:
                raw_text = f.file.read().decode("utf-8", errors="replace")
            target_name = (post.get("name") or "").strip()
        except Exception as e:  # noqa: BLE001
            return web.json_response({"ok": False, "error": f"上传解析失败：{e}"}, status=400)
    else:
        try:
            payload = await request.json()
        except Exception:  # noqa: BLE001
            raw_text = (await request.text()) or ""
        else:
            if isinstance(payload, dict):
                target_name = (payload.get("name") or "").strip()
                if "content" in payload:
                    raw_text = str(payload.get("content") or "")
                    payload = None

    if payload is None:
        if not raw_text.strip():
            return web.json_response({"ok": False, "error": "没有收到内容"}, status=400)
        res = custom_dict.import_dict(raw_text, target_name)
    else:
        res = custom_dict.import_dict(payload, target_name)

    return web.json_response(res, status=200 if res.get("ok") else 400)


@ROUTES.get("/easy_cn_prompt/dicts/tags")
async def dicts_tags(request: web.Request) -> web.Response:
    """列出某词库（或全部）的词条。"""
    from ..lexicon import custom_dict

    did = request.query.get("id")
    try:
        did_i = int(did) if did not in (None, "", "all") else None
    except Exception:  # noqa: BLE001
        did_i = None
    return web.json_response({"ok": True, "tags": custom_dict.list_all(dict_id=did_i)})


# ---------------- 自动分类（SetFit） ----------------

@ROUTES.get("/easy_cn_prompt/classify/status")
async def classify_status(request: web.Request) -> web.Response:
    """分类器是否可用。"""
    from ..translate import classify

    ok, why = classify.available()
    return web.json_response({"ok": True, "ready": ok, "message": why})


@ROUTES.post("/easy_cn_prompt/classify")
async def classify_tags(request: web.Request) -> web.Response:
    """对一批标签自动分类。

    请求：{"items": ["长发 长发", "水枪 水枪"]}
      —— 每项是「中文名 英文标签」，中文名提供关键语义信息。
    返回：{"ok": true, "results": [{"text","cat","conf"}]}

    只有置信度 ≥ 阈值的才建议采纳（默认 0.6），
    前端按 0.8 直接采纳 / 0.6~0.8 待复核 两档处理。
    """
    import anyio

    from ..translate import classify

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    items = body.get("items") or []
    if not isinstance(items, list) or not items:
        return web.json_response({"ok": False, "error": "items 不能为空"}, status=400)

    ok, why = classify.available()
    if not ok:
        return web.json_response({"ok": False, "error": why}, status=400)

    # 子进程推理会阻塞，丢线程池
    res = await anyio.to_thread.run_sync(
        lambda: classify.classify([str(x) for x in items[:200]])
    )
    if not res.get("ok"):
        return web.json_response(res, status=500)
    return web.json_response(res)


@ROUTES.post("/easy_cn_prompt/dicts/set_default")
async def dicts_set_default(request: web.Request) -> web.Response:
    """设置「一键收录」的目标词库。传 id=0 表示取消默认。"""
    from ..lexicon import custom_dict

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    did = body.get("id") or 0
    res = custom_dict.set_default_dict(int(did) if did else None)
    return web.json_response(res, status=200 if res.get("ok") else 400)


@ROUTES.get("/easy_cn_prompt/dicts/default")
async def dicts_get_default(request: web.Request) -> web.Response:
    """取默认词库（一键收录的目标）。未设置时 dict 为 null。"""
    from ..lexicon import custom_dict

    return web.json_response({"ok": True, "dict": custom_dict.get_default_dict()})


# ---------------- 设置：类型顺序 ----------------

@ROUTES.get("/easy_cn_prompt/settings/category_order")
async def settings_get_order(request: web.Request) -> web.Response:
    """取类型排序（用于「整理词块」）。待确认永远在最后。"""
    from ..lexicon import custom_dict

    return web.json_response({"ok": True, "order": custom_dict.get_category_order()})


@ROUTES.post("/easy_cn_prompt/settings/category_order")
async def settings_set_order(request: web.Request) -> web.Response:
    """保存类型排序。待确认会被强制挪到最后。"""
    from ..lexicon import custom_dict

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    res = custom_dict.set_category_order(body.get("order") or [])
    return web.json_response(res, status=200 if res.get("ok") else 400)


@ROUTES.get("/easy_cn_prompt/settings/confidence")
async def settings_get_conf(request: web.Request) -> web.Response:
    """取分类置信度阈值。"""
    from ..lexicon import custom_dict

    return web.json_response({"ok": True, "confidence": custom_dict.get_confidence()})


@ROUTES.post("/easy_cn_prompt/settings/confidence")
async def settings_set_conf(request: web.Request) -> web.Response:
    """设置分类置信度阈值（0.5~0.99）。"""
    from ..lexicon import custom_dict

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)
    res = custom_dict.set_confidence(body.get("confidence", custom_dict.CONF_DEFAULT))
    return web.json_response(res, status=200 if res.get("ok") else 400)


@ROUTES.post("/easy_cn_prompt/builtin/set_category")
async def builtin_set_category(request: web.Request) -> web.Response:
    """直接修改**内置词库**里标签的分类。

    需求方明确要求：改内置词库的词时直接改 tag.sqlite（§12X）。
    写前自动备份。
    """
    from ..lexicon.db import update_builtin_categories

    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        return web.json_response({"ok": False, "error": "请求体不是合法 JSON"}, status=400)

    pairs = body.get("pairs") or []
    if not pairs and body.get("en"):
        pairs = [[body["en"], body.get("category", 0)]]
    res = update_builtin_categories([(p[0], p[1]) for p in pairs if len(p) >= 2])
    return web.json_response(res, status=200 if res.get("ok") else 400)
