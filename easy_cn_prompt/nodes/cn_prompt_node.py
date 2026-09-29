"""EasyCNPrompt 节点：把带 <chunk> 标记的文本解析成纯英文提示词。

标记格式（见开发文档 §5.3）：
    <chunk>english_tag</chunk>
    <chunk>english_tag|disabled</chunk>
    <chunk>english_tag|cn=中文显示名</chunk>
    <chunk>english_tag|cn=中文|disabled</chunk>
"""

from __future__ import annotations

import re

CHUNK_RE = re.compile(r"<chunk>(.*?)</chunk>", re.S)

# 基础模型：影响标签的输出格式（大小写 / 下划线 / 前缀 / 质量词）
#
# 命名沿用「基础模型」是因为该字段早已存在，改名会破坏旧工作流。
# 每个模型对应一组规则，见 MODEL_RULES。
GENERAL_MODEL = "通用（Danbooru）"
ANIMA_MODEL = "Anima"
ILLUSTRIOUS_MODEL = "Illustrious / NoobAI"
PONY_MODEL = "Pony V6"
FLUX_MODEL = "Flux（自然语言）"
BASE_MODELS = [
    GENERAL_MODEL,
    ANIMA_MODEL,
    ILLUSTRIOUS_MODEL,
    PONY_MODEL,
    FLUX_MODEL,
]

# 各模型的标签规则。
#
# 依据（均为各方官方文档 / 社区标准用法）：
#   · Danbooru 原生：标签内空格写作下划线，标签之间用逗号分隔
#     https://danbooru.donmai.us/wiki_pages/help:tags
#   · Anima / Animagine：空格分隔、全小写、画师加 @
#   · Illustrious / NoobAI：Danbooru 下划线风格，推荐加 masterpiece / best quality
#   · Pony V6：需要 score_9, score_8_up, score_7_up, source_anime 前缀
#   · Flux：自然语言友好，下划线应换成空格，且权重语法支持有限
MODEL_RULES: dict[str, dict] = {
    GENERAL_MODEL: {
        "lower": False,            # 是否全部转小写
        "underscore_to_space": False,  # 下划线是否换空格
        "keep_underscore_cats": (),    # 保留下划线的类别（不论上面开关）
        "artist_prefix": "",       # 画师标签前缀
        "quality_suffix": "",      # 恒定追加的质量词
        "note": "Danbooru 原生格式：保留下划线",
    },
    ANIMA_MODEL: {
        "lower": True,
        "underscore_to_space": True,
        # 角色与质量词保留下划线（官方模板里 absurdres / 角色名都带下划线风格）
        "keep_underscore_cats": (4, 90),
        "keep_case_cats": (4,),    # 角色保留大小写（官方未要求小写化）
        "artist_prefix": "@",
        "quality_suffix": "",
        "note": "Animagine：空格分隔、全小写、画师加 @",
    },
    ILLUSTRIOUS_MODEL: {
        "lower": True,
        "underscore_to_space": False,   # 保持 Danbooru 下划线风格
        "keep_underscore_cats": (),
        "artist_prefix": "",
        "quality_suffix": "masterpiece, best quality",
        "note": "Illustrious/NoobAI：下划线风格 + 推荐质量词",
    },
    PONY_MODEL: {
        "lower": True,
        "underscore_to_space": False,
        "keep_underscore_cats": (),
        "artist_prefix": "",
        "quality_suffix": "score_9, score_8_up, score_7_up, source_anime",
        "note": "Pony V6：score_ 前缀 + 下划线风格",
    },
    FLUX_MODEL: {
        "lower": True,
        "underscore_to_space": True,    # Flux 偏好自然语言
        "keep_underscore_cats": (),
        "artist_prefix": "",
        "quality_suffix": "",
        "note": "Flux：自然语言友好，下划线换空格",
    },
}

# 画师标签在词库里的 category
ARTIST_CATEGORY = 1
# 角色标签
CHARACTER_CATEGORY = 4
# 质量词（插件自造类别，见 lexicon/db.py CATEGORY_META）
QUALITY_CATEGORY = 90

# 分隔符固定为「逗号 + 空格」，不再暴露给用户
SEPARATOR = ", "

# 没有可用翻译模型时下拉里的占位项
NO_TRANS_MODEL = "（未找到翻译模型）"


def _trans_model_choices() -> list[str]:
    """扫描翻译模型目录，给出下拉选项。

    每次刷新节点定义时会重新扫描，所以放进 gguf 后重开 ComfyUI 即可看到。
    """
    try:
        from ..translate import base as tb

        names = [m["name"] for m in tb.list_models()]
        return names or [NO_TRANS_MODEL]
    except Exception:  # noqa: BLE001
        return [NO_TRANS_MODEL]


def _default_trans_model() -> str:
    choices = _trans_model_choices()
    return choices[0] if choices else NO_TRANS_MODEL


def _is_anima(base_model: str) -> bool:
    return (base_model or "").strip().lower() == ANIMA_MODEL.lower()


def _rules_for(base_model: str) -> dict:
    """取某模型的规则；未知模型退回通用规则。"""
    return MODEL_RULES.get(base_model or "", MODEL_RULES[GENERAL_MODEL])


def _format_tag(en: str, category: int, base_model: str, escape_parens: bool = False) -> str:
    """按所选模型的规则格式化单个标签。

    所有行为由 MODEL_RULES 驱动：
      · lower               —— 是否全部转小写
      · underscore_to_space —— 下划线是否换成空格
      · keep_underscore_cats—— 这些类别保留下划线（如 Anima 的角色/质量词）
      · keep_case_cats      —— 这些类别保留大小写
      · artist_prefix       —— 画师标签前缀（Anima 的 @）
    """
    if not en:
        return en

    r = _rules_for(base_model)
    keep_us = tuple(r.get("keep_underscore_cats", ()))
    keep_case = tuple(r.get("keep_case_cats", ()))

    # 大小写
    if r.get("lower") and category not in keep_case:
        en = en.lower()

    # 下划线
    if r.get("underscore_to_space") and category not in keep_us:
        en = en.replace("_", " ")

    # 画师前缀
    prefix = r.get("artist_prefix") or ""
    if prefix and category == ARTIST_CATEGORY and not en.startswith(prefix):
        en = prefix + en

    if escape_parens:
        en = en.replace("(", "\\(").replace(")", "\\)")
    return en


def quality_suffix_for(base_model: str) -> str:
    """该模型恒定追加的质量词（Illustrious / Pony 需要）。"""
    return _rules_for(base_model).get("quality_suffix", "") or ""


def _format_weight(en: str, weight: float | None, escape_parens: bool = False) -> str:
    """按 A1111 语法加权重：`(tag:1.2)`。

    weight 为 None 或 1.0 时不加（保持干净输出）。
    """
    if weight is None:
        return en
    try:
        w = float(weight)
    except (TypeError, ValueError):
        return en
    if abs(w - 1.0) < 1e-9:
        return en
    # 去掉多余的小数零：1.20 -> 1.2
    txt = f"{w:.4f}".rstrip("0").rstrip(".")
    if escape_parens:
        # 转义模式下括号本身要被转义，权重语法就没法用了，退回原词
        return en
    return f"({en}:{txt})"


def _split_payload(payload: str) -> tuple[str, dict]:
    """拆出英文词与标志位。`\\|` 为转义竖线。"""
    # 先把转义的竖线换成占位符，避免被切分
    SENTINEL = "\x00PIPE\x00"
    work = payload.replace("\\|", SENTINEL)
    parts = work.split("|")

    en = parts[0].replace(SENTINEL, "|").strip()
    flags: dict = {}
    for p in parts[1:]:
        p = p.replace(SENTINEL, "|").strip()
        if not p:
            continue
        if "=" in p:
            k, v = p.split("=", 1)
            flags[k.strip()] = v.strip()
        else:
            flags[p] = True
    return en, flags


def _clean(en: str, escape_parens: bool = False) -> str:
    if escape_parens:
        en = en.replace("(", "\\(").replace(")", "\\)")
    return en


def parse_weight_syntax(seg: str) -> tuple[str, float | None]:
    """从一段文本里解析 A1111 权重语法。

    支持：
        twintails            -> ("twintails", None)
        (twintails:1.2)      -> ("twintails", 1.2)
        (twintails)          -> ("twintails", 1.1)    括号堆叠 = 每层 *1.1
        ((twintails))        -> ("twintails", 1.21)
        (twintails:0.8)      -> ("twintails", 0.8)
        twintails:1.2        -> ("twintails", 1.2)    裸冒号写法也认

    无法解析时原样返回 (原文, None)。
    """
    if not seg:
        return seg, None
    s = seg.strip()

    # ---- 情况一：被括号包裹 ----
    if s.startswith("(") and s.endswith(")"):
        depth = 0
        while depth < len(s) and s[depth] == "(":
            depth += 1
        # 确认括号完全包裹（末尾正好闭合 depth 层）
        if s.endswith(")" * depth):
            inner = s[depth: len(s) - depth].strip()
            if inner:
                # 显式权重：(tag:1.2)
                m = re.match(r"^(?P<tag>.+?)\s*:\s*(?P<w>[0-9]*\.?[0-9]+)$", inner)
                if m:
                    try:
                        return m.group("tag").strip(), float(m.group("w"))
                    except ValueError:
                        return inner, None
                # 纯括号堆叠：((tag)) == 1.1 ** depth
                return inner, round(1.1 ** depth, 4)

    # ---- 情况二：裸冒号写法 tag:1.2 ----
    m = re.match(r"^(?P<tag>.+?)\s*:\s*(?P<w>[0-9]*\.?[0-9]+)$", s)
    if m and "/" not in s:
        tag = m.group("tag").strip()
        # 排除 Danbooru 里形如 "foo:bar" 的标签，避免误判
        if tag and not tag.endswith(":"):
            try:
                return tag, float(m.group("w"))
            except ValueError:
                pass

    return s, None


def parse_chunks(text: str, separator: str = ",", escape_parens: bool = False,
                 base_model: str = GENERAL_MODEL) -> tuple[str, list[str]]:
    """返回 (输出文本, 被禁用的英文词列表)。

    编辑器里每个词块自带一个尾随英文逗号（序列化形式 `<chunk>..</chunk>,`），
    这里按"块"重组：块与块之间统一用 separator 连接，
    块与裸文本之间保留用户原本的写法，最后再统一归一化多余分隔符。
    """
    if not text:
        return "", []

    # 先把文本切成 token 序列：("chunk", en, flags) / ("text", 原文)
    tokens: list[tuple] = []
    pos = 0
    for m in CHUNK_RE.finditer(text):
        if m.start() > pos:
            tokens.append(("text", text[pos:m.start()]))
        en, flags = _split_payload(m.group(1))
        try:
            cat = int(flags.get("cat", 0) or 0)
        except (TypeError, ValueError):
            cat = 0
        weight = flags.get("w")      # 权重，形如 w=1.2；无则 None
        tokens.append(("chunk", en, flags, cat, weight))
        pos = m.end()
        # 词块自带的英文逗号：吃掉，由 separator 统一补齐
        if text[pos:pos + 1] == ",":
            pos += 1
    if pos < len(text):
        tokens.append(("text", text[pos:]))

    out: list[str] = []
    disabled: list[str] = []
    prev_was_chunk = False

    for tk in tokens:
        if tk[0] == "text":
            raw = tk[1]
            if not raw.strip():
                continue  # 纯空白 token 直接丢弃，避免产生空段
            # 前一个 token 是词块时，裸文本前补一个分隔符，
            # 否则会粘成 "a尾巴"
            if prev_was_chunk and not raw.lstrip().startswith(tuple(",，\n")):
                out.append(separator)
            out.append(raw)
            prev_was_chunk = False
            continue

        _, en, flags, cat, weight = tk
        if not en:
            continue
        # 前一个 token 也是词块时，补一个分隔符
        if prev_was_chunk:
            out.append(separator)
        if flags.get("disabled"):
            disabled.append(en)
        else:
            tag = _format_tag(en, cat, base_model, escape_parens)
            out.append(_format_weight(tag, weight, escape_parens))
        prev_was_chunk = True

    joined = "".join(out)
    # 归一化：统一分隔符、压掉重复与多余空白
    joined = re.sub(r"[ \t]*\n[ \t]*", "\n", joined)
    if separator == "\n":
        joined = re.sub(r"\s*,\s*", separator, joined)
    else:
        joined = re.sub(r"\s*,\s*", separator, joined)
    joined = re.sub(rf"(?:{re.escape(separator)})+", separator, joined)
    joined = re.sub(r"\s{2,}", " ", joined).strip()
    joined = joined.strip(f"{separator} \n") if separator != "\n" else joined.strip(" \n,")

    return joined, disabled


class EasyCNPrompt:
    """中文提示词节点（文本在后端只做解析，交互全在前端）。"""

    @classmethod
    def INPUT_TYPES(cls):
        # 说明：
        #   · 键名（prompt_text / base_model …）是**接口契约**，必须保持英文，
        #     改掉会让旧工作流失效。
        #   · 界面上显示的文字由 `label` 控制 —— 全部用中文。
        #   · tooltip 会被 ComfyUI 渲染成悬停提示。
        return {
            "required": {
                "prompt_text": ("STRING", {
                    "multiline": True,
                    "default": "",
                    "dynamicPrompts": False,
                    "label": "提示词",
                    "tooltip": (
                        "在这里用中文写提示词。\n"
                        "· 直接打字会弹出候选框，点选即插入词块\n"
                        "· 输入逗号（中英文都行）结束一个词，自动转成词块\n"
                        "· 也可直接粘贴整段中英文提示词，会自动拆成词块\n"
                        "· 单击词块＝禁用／启用，双击＝打开编辑菜单"
                    ),
                }),
                "base_model": (BASE_MODELS, {
                    "default": "通用（Danbooru）",
                    "label": "出图模型规则",
                    "tooltip": (
                        "选择目标绘画模型，决定标签的输出格式。\n"
                        "· 通用（Danbooru）：保留下划线，如 long_hair\n"
                        "· Anima：下划线换空格、全小写、画师加 @\n"
                        "· Illustrious / NoobAI：下划线风格，自动加 masterpiece, best quality\n"
                        "· Pony V6：下划线风格，自动加 score_9, score_8_up, score_7_up, source_anime\n"
                        "· Flux（自然语言）：下划线换空格，更贴近自然语言"
                    ),
                }),
                "trans_model": (_trans_model_choices(), {
                    "default": _default_trans_model(),
                    "label": "翻译模型",
                    "tooltip": (
                        "用于把「未收录」的中文词块翻译成英文标签（本地 Hy-MT2）。\n"
                        "把 .gguf 模型放进 ComfyUI/models/easy_cn_prompt/ 后重启即可出现在这里。\n"
                        "首次翻译需要加载模型，可能要等几十秒；之后会走缓存。"
                    ),
                }),
                "auto_comma": (["开启", "关闭"], {
                    "default": "开启",
                    "label": "中文逗号自动转英文",
                    "tooltip": (
                        "开启后，你**新键入**的中文逗号「，」会自动变成英文逗号「,」。\n"
                        "· 只影响开启之后新输入的逗号，框里已有的内容不会被改写\n"
                        "· 英文逗号才会触发词块；关闭开关后中文逗号完全不干预\n"
                        "· 想用中文逗号直接建词块？请改为「关闭」"
                    ),
                }),
                "mode": (["替换", "追加"], {
                    "default": "替换",
                    "label": "连线文本处理方式",
                    "tooltip": (
                        "决定 text_in 连线进来的文本如何处理：\n"
                        "· 替换：忽略节点里手写的词块，只输出连线文本\n"
                        "· 追加：把手写词块和连线文本拼在一起输出"
                    ),
                }),
            },
            "optional": {
                # 连线输入：一段普通提示词文本，会在前端自动拆成词块
                "text_in": ("STRING", {
                    "forceInput": True,
                    "default": "",
                    "label": "文本输入",
                    "tooltip": (
                        "可选的文本连线输入（普通提示词，中英文皆可）。\n"
                        "接入后会自动查词库拆分成词块，并显示在编辑框里。\n"
                        "具体是「替换」还是「追加」，由上面的连线文本处理方式决定。"
                    ),
                }),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("提示词",)
    FUNCTION = "build"
    CATEGORY = "EasyCNPrompt"
    DESCRIPTION = (
        "中文提示词节点：用中文写提示词，自动补全并输出英文标签。\n"
        "· 打字弹候选、输入逗号自动成词块、粘贴整段文本自动拆分\n"
        "· 支持 Danbooru / Anima / Illustrious / Pony V6 / Flux 五种输出规则\n"
        "· 未收录的词块可用本地 Hy-MT2 翻译成英文标签\n"
        "· text_in 可连线接入一段文本，自动拆成词块"
    )

    def build(self, prompt_text: str, base_model: str = BASE_MODELS[0],
              trans_model: str = "", auto_comma: str = "开启", mode: str = "替换",
              text_in: str = "", unique_id=None):
        # auto_comma 只影响前端输入行为（中文逗号自动转英文），
        # 后端不参与处理，但**必须接收**这个参数，否则 ComfyUI 调用时会报
        # "got an unexpected keyword argument"，节点直接执行失败。
        _ = auto_comma

        # ---- 参数归一化（重要）----
        # 旧工作流加载时 widgets_values 可能错位，各种非法值都往这里灌。
        # 统一校正，保证任何来源的参数都能正常出结果，不抛异常。
        mode = mode if mode in ("替换", "追加") else "替换"
        base_model = base_model if base_model in BASE_MODELS else BASE_MODELS[0]
        prompt_text = prompt_text if isinstance(prompt_text, str) else ""
        text_in = text_in if isinstance(text_in, str) else ""

        # 分隔符固定为 ", "，不再由用户选择
        separator = SEPARATOR

        manual, _disabled = parse_chunks(prompt_text or "", separator, False, base_model)

        # 连线进来的文本是**普通提示词**（可能是中文、英文或中英混排），
        # 不是带 <chunk> 标记的编辑器内容。因此这里要真正查词库翻译，
        # 否则 "双马尾" 会原样漏进最终提示词。
        wired = resolve_prompt(text_in or "", separator, False, base_model)

        if mode == "替换" and wired:
            result = wired
        elif wired:
            result = _join(manual, wired, separator)
        else:
            result = manual

        # 某些模型恒定追加质量词（Illustrious 的 masterpiece/best quality、
        # Pony 的 score_9 前缀等）。追加在**最前面** —— 这是各方文档的惯例，
        # 且 Pony 明确要求 score_ 系列排在最前。
        qs = quality_suffix_for(base_model)
        if qs and result:
            parts = [p.strip() for p in result.split(separator) if p.strip()]
            for q in reversed([x.strip() for x in qs.split(",") if x.strip()]):
                if q not in parts:
                    parts.insert(0, q)
            result = separator.join(parts)

        # 把连线进来的原文回传给前端。
        # 前端无法从 node.inputs[].value 拿到上游的值（ComfyUI 不会写进去），
        # 只能靠执行结果里的 ui 消息得知"上游送来了什么"，
        # 据此在编辑框里生成词块。
        raw_in = "" if text_in is None else str(text_in)
        return {
            "ui": {"ecp_wired_text": [raw_in]},
            "result": (result,),
        }


def resolve_prompt(text: str, separator: str = ",", escape_parens: bool = False,
                   base_model: str = GENERAL_MODEL) -> str:
    """把一段普通提示词解析成英文 Danbooru 标签串。

    - 已经是 <chunk> 标记内容 → 直接按标记解析
    - 否则按逗号/分号/换行拆段，逐段查词库（英文精确 → 中文精确 → 中文子串）
    - 查不到的原样保留（用户可能就是想要那个词）

    词库不可用时退化为原样清洗，不影响主流程。
    """
    if not text or not str(text).strip():
        return ""

    # 若上游本身就是带标记的编辑器内容，直接按标记解析
    if "<chunk>" in text:
        parsed, _ = parse_chunks(text, separator, escape_parens, base_model)
        return parsed

    try:
        from ..lexicon.db import get_lexicon

        lex = get_lexicon()
    except Exception:  # noqa: BLE001
        lex = None

    segs = [s.strip() for s in re.split(r"[,，;；\n]+", text) if s.strip()]
    out: list[str] = []
    for seg in segs:
        # 先剥离 A1111 权重语法，再拿干净的标签去查词库
        bare, weight = parse_weight_syntax(seg)

        hit = None
        if lex is not None:
            try:
                hit = lex.lookup_en(bare)
                if hit is None:
                    cn_hits = lex.lookup_cn(bare)
                    hit = cn_hits[0] if cn_hits else None
                if hit is None and _has_cjk(bare):
                    sub = lex.search(bare, limit=1)
                    hit = sub[0] if sub else None
            except Exception:  # noqa: BLE001
                hit = None

        if hit:
            tag = _format_tag(hit["en"], hit.get("category", 0), base_model, escape_parens)
        else:
            tag = _clean(bare, escape_parens)
        out.append(_format_weight(tag, weight, escape_parens))

    return separator.join(out)


def _has_cjk(s: str) -> bool:
    return any("\u4e00" <= ch <= "\u9fff" for ch in s)


def _coerce_separator(sep) -> str:
    """把 separator 归一化成合法的字符串分隔符。

    旧工作流错位时这里可能收到 false / "替换" / None 等非法值，
    直接用于 join() 会抛 TypeError 导致节点无输出。
    """
    if isinstance(sep, str) and sep != "":
        return sep
    return ", "   # 默认值，与 INPUT_TYPES 保持一致


def _join(a: str, b: str, separator: str) -> str:
    """把两段提示词用分隔符拼起来，去重、去空段与重复分隔符。

    手动内容与连线内容常常重复（比如两边都有 1girl），
    直接拼接会出现 "1girl,1girl,long_hair"，这里按段去重（保留首次出现顺序）。
    """
    parts: list[str] = []
    for src in (a or "", b or ""):
        for seg in src.split(separator):
            seg = seg.strip()
            if seg and seg not in parts:
                parts.append(seg)
    joined = separator.join(parts)
    joined = re.sub(rf"(?:{re.escape(separator)})+", separator, joined)
    return joined.strip(f"{separator} \n") if separator != "\n" else joined.strip(" \n,")


NODE_CLASS_MAPPINGS = {
    "EasyCNPrompt": EasyCNPrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "EasyCNPrompt": "Easy CN Prompt (中文提示词)",
}
