"""词库访问层：只读打开 tag.sqlite，旁挂 FTS5 索引。

设计约束（见开发文档 §9.1）：
  * 原库 tag.sqlite 属于 git 仓库（每日更新），**绝不在原文件内建表**。
  * 索引建立在插件自己的 data/ 目录下，通过 ATTACH 读原库构建。
"""

from __future__ import annotations

import glob
import os
import sqlite3
import threading
import time

# category 元数据（供前端着色，见开发文档 §6.7）
# 90 是插件自造的"质量词"类别：Danbooru 原生没有质量词，它们是模型侧约定
# （masterpiece / high score / absurdres 等，见 Anima 官方提示词模板）。
CATEGORY_META = {
    0:  {"key": "other",       "label": "其他",     "color": "#5a5f66"},
    1:  {"key": "artist",      "label": "艺术家",   "color": "#8a3636"},
    2:  {"key": "style",       "label": "风格",     "color": "#7a5fb0"},
    3:  {"key": "copyright",   "label": "版权/作品", "color": "#6a4a8a"},
    4:  {"key": "character",   "label": "角色",     "color": "#3d7a4a"},
    5:  {"key": "quality",     "label": "质量词",   "color": "#b8860b"},
    6:  {"key": "headwear",    "label": "头饰",     "color": "#c06a9a"},
    7:  {"key": "hair",        "label": "头发",     "color": "#a8622c"},
    8:  {"key": "eyes",        "label": "眼睛",     "color": "#2f7fb5"},
    9:  {"key": "ears",        "label": "耳朵",     "color": "#b58a3a"},
    10: {"key": "expression",  "label": "表情",     "color": "#c25b5b"},
    11: {"key": "pose",        "label": "姿势",     "color": "#4a8a86"},
    12: {"key": "background",  "label": "背景",     "color": "#4a7a3a"},
    13: {"key": "form",        "label": "形式",     "color": "#6b6b8a"},
    14: {"key": "shot",        "label": "镜头",     "color": "#3a6ea5"},
    15: {"key": "view",        "label": "视角",     "color": "#5a8ab5"},
    16: {"key": "effect",      "label": "画面效果", "color": "#9a6a3a"},
    17: {"key": "clothing",    "label": "服装",     "color": "#5566a0"},
    18: {"key": "accessory",   "label": "配饰",     "color": "#b0784a"},
    19: {"key": "prop",        "label": "道具",     "color": "#7a7a5a"},
    20: {"key": "body",        "label": "身体特征", "color": "#a06a6a"},
    # 21 是"待确认"：机器自动分类置信度中等，等人复核。
    # 复核方式：双击词块 →「编辑类型」改成正确的类别即可。
    21: {"key": "pending",     "label": "待确认",   "color": "#8a8a3a"},
}

# Anima 官方正面质量词（Animagine XL 4.0 提示词模板）
# 内置质量词集合。
# 来源：Animagine 官方模板 + KGen 的 POSSIBLE_QUALITY_TAGS（26 个，社区通用）。
# 这些词不在 Danbooru 词库里（模型侧约定），搜索时由这里兜底命中。
QUALITY_TAGS = [
    # ── 画质/杰作 ──
    {"en": "masterpiece", "cn": "杰作"},
    {"en": "best quality", "cn": "最佳质量"},
    {"en": "great quality", "cn": "极好质量"},
    {"en": "good quality", "cn": "好质量"},
    {"en": "normal quality", "cn": "普通质量"},
    {"en": "low quality", "cn": "低质量"},
    {"en": "worse quality", "cn": "更差质量"},
    {"en": "worst quality", "cn": "最差质量"},
    # ── 美感 ──
    {"en": "very aesthetic", "cn": "高美感"},
    {"en": "aesthetic", "cn": "美感"},
    {"en": "displeasing", "cn": "不悦"},
    {"en": "very displeasing", "cn": "很不悦"},
    # ── 年代 ──
    {"en": "newest", "cn": "最新"},
    {"en": "recent", "cn": "近期"},
    {"en": "mid", "cn": "中期"},
    {"en": "early", "cn": "早期"},
    {"en": "old", "cn": "早期(旧)"},
    # ── 分数系 ──
    {"en": "high score", "cn": "高分"},
    {"en": "great score", "cn": "极佳"},
    {"en": "score_9", "cn": "9分"},
    {"en": "score_8_up", "cn": "8分以上"},
    {"en": "score_7_up", "cn": "7分以上"},
    {"en": "score_6_up", "cn": "6分以上"},
    {"en": "score_5_up", "cn": "5分以上"},
    {"en": "score_4_up", "cn": "4分以上"},
    # ── 来源/其他 ──
    {"en": "source_anime", "cn": "动漫来源"},
    {"en": "source_cartoon", "cn": "卡通来源"},
    {"en": "source_furry", "cn": "兽人来源"},
    {"en": "source_pony", "cn": "小马来源"},
    {"en": "absurdres", "cn": "超高分辨率"},
    {"en": "highres", "cn": "高分辨率"},
    {"en": "lowres", "cn": "低分辨率"},
    # ── 分辨率/清晰度补充 ──
    {"en": "8k", "cn": "8K"},
    {"en": "UHD", "cn": "超高清"},
    {"en": "ultra-detailed", "cn": "超精细"},
    {"en": "sharp focus", "cn": "锐利对焦"},
    {"en": "highly detailed", "cn": "高细节"},
    {"en": "intricate details", "cn": "复杂细节"},
    {"en": "professional", "cn": "专业级"},
    {"en": "masterful composition", "cn": "大师构图"},
    {"en": "cinematic lighting", "cn": "电影光效"},
    {"en": "worst detail", "cn": "最差细节"},
    # ── 负面/缺陷类 ──
    {"en": "score_1", "cn": "1分"},
    {"en": "score_2", "cn": "2分"},
    {"en": "score_3", "cn": "3分"},
    {"en": "score_8", "cn": "8分"},
    {"en": "score_7", "cn": "7分"},
    {"en": "very awa", "cn": "超级可爱(awa)"},
    {"en": "jpeg artifacts", "cn": "JPEG压缩痕迹"},
    {"en": "bad anatomy", "cn": "人体结构错误"},
    {"en": "bad hands", "cn": "手部画崩"},
    {"en": "extra fingers", "cn": "多指"},
    # ── 画面标记类（需求方明确归入质量词） ──
    {"en": "sketch", "cn": "草稿"},
    {"en": "blurry", "cn": "模糊"},
    {"en": "watermark", "cn": "水印"},
    {"en": "signature", "cn": "签名"},
    {"en": "artist name", "cn": "作者名"},
]

# 注意：插件通常以**符号链接**形式装进 custom_nodes，__file__ 会被解析成真实路径。
# 因此这里用 realpath，保证在开发目录和 custom_nodes 两种情况下都能定位到正确位置。
_PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
WORKSPACE_ROOT = os.path.dirname(_PLUGIN_ROOT)

# 词库目录名（仓库根目录下的子目录）
_LEXICON_DIR_NAMES = [
    "ffdkj-Danbooru_Tag-Chinese-English-Translation-Table",
]


def _candidate_db_paths() -> list[str]:
    """按优先级返回可能的 tag.sqlite 路径。"""
    paths = []
    env = os.environ.get("EASY_CN_PROMPT_DB")
    if env:
        paths.append(env)

    # 1) 插件目录自己的 data/
    paths.append(os.path.join(_PLUGIN_ROOT, "data", "tag.sqlite"))

    # 2) 插件上一级（开发仓库根目录）下的词库仓库
    for name in _LEXICON_DIR_NAMES:
        paths.append(os.path.join(WORKSPACE_ROOT, name, "tag.sqlite"))

    # 3) 上一级目录里任何 *Tag-Chinese-English* / *tag* 目录（容错）
    for pat in ("*Tag-Chinese-English*", "*Tag-Chinese*", "*danbooru*tag*"):
        for d in glob.glob(os.path.join(WORKSPACE_ROOT, pat)):
            paths.append(os.path.join(d, "tag.sqlite"))

    # 4) ComfyUI 的 models/easy_cn_prompt/（正式安装时把词库放这里）
    paths.append(os.path.join(_comfy_models_dir() or "", "easy_cn_prompt", "tag.sqlite"))
    return [p for p in paths if p]


def _comfy_models_dir() -> str | None:
    try:
        import folder_paths  # type: ignore

        return folder_paths.models_dir
    except Exception:  # noqa: BLE001
        return None


def find_db_path() -> str | None:
    for p in _candidate_db_paths():
        if p and os.path.isfile(p):
            return p
    return None


def _has_cjk(s: str) -> bool:
    for ch in s:
        if "\u4e00" <= ch <= "\u9fff" or "\u3400" <= ch <= "\u4dbf":
            return True
    return False


class Lexicon:
    """词库查询器。线程安全（每次查询用独立连接）。"""

    def __init__(self, db_path: str | None = None):
        self.db_path = db_path or find_db_path()
        self._lock = threading.Lock()
        self._cache: dict[tuple, tuple[float, list]] = {}
        self._cache_ttl = 60.0
        self._count: int | None = None

    # ---------- 基础 ----------

    @property
    def available(self) -> bool:
        return bool(self.db_path) and os.path.isfile(self.db_path or "")

    def _connect(self) -> sqlite3.Connection:
        # 只读 + 允许跨线程
        conn = sqlite3.connect(f"file:{self.db_path}?mode=ro", uri=True, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        return conn

    def stats(self) -> dict:
        if not self.available:
            return {"available": False, "db_path": None, "total": 0}
        try:
            with self._connect() as conn:
                if self._count is None:
                    self._count = conn.execute("SELECT COUNT(*) FROM tags").fetchone()[0]
                rows = conn.execute(
                    "SELECT category, COUNT(*) c FROM tags GROUP BY category ORDER BY c DESC"
                ).fetchall()
            return {
                "available": True,
                "db_path": self.db_path,
                "total": self._count,
                "by_category": {r["category"]: r["c"] for r in rows},
                "mtime": os.path.getmtime(self.db_path),
            }
        except Exception as exc:  # noqa: BLE001
            return {"available": False, "db_path": self.db_path, "error": str(exc), "total": 0}

    # ---------- 查询 ----------

    def _row_to_item(self, row: sqlite3.Row, source: str = "builtin") -> dict:
        en = row["name"]
        cn = row["cn_name"] or en
        cat = row["category"] if row["category"] is not None else 0
        meta = CATEGORY_META.get(cat, {"key": "unknown", "label": f"类别{cat}", "color": "#5a5f66"})
        return {
            "en": en,
            "cn": cn,
            "category": cat,
            "category_key": meta["key"],
            "category_label": meta["label"],
            "post_count": row["post_count"] or 0,
            "has_cn": bool(cn) and cn != en,
            "source": source,
        }

    @staticmethod
    def _custom_to_item(row) -> dict:
        cat = row["category"] if row["category"] is not None else 0
        meta = CATEGORY_META.get(cat, {"key": "unknown", "label": f"类别{cat}", "color": "#5a5f66"})
        return {
            "en": row["en"],
            "cn": row["cn"] or row["en"],
            "category": cat,
            "category_key": meta["key"],
            "category_label": meta["label"],
            # 自定义条目永远排最前，给一个极大的引用数
            "post_count": 10 ** 12,
            "has_cn": bool(row["cn"]) and row["cn"] != row["en"],
            "source": "custom",
        }

    def _enabled_dict_ids(self) -> list[int] | None:
        """启用的词库 id（按优先级）。None 表示查询失败，调用方按"不过滤"处理。"""
        try:
            from . import custom_dict

            return custom_dict.enabled_dict_ids()
        except Exception:  # noqa: BLE001
            return None

    def _search_custom(self, q: str, limit: int) -> list[dict]:
        """在自定义词库里查（中英都是子串匹配）。

        ⚠️ 按**词库顺序**返回：顺序靠前的词库，其结果排在前面 ——
        这就是"词库顺序决定智能提示优先级"的实现。
        禁用的词库直接跳过。
        """
        try:
            from . import custom_dict

            ids = self._enabled_dict_ids()
            if ids is not None and not ids:
                return []          # 所有词库都被禁用
            with custom_dict._lock, custom_dict._connect() as conn:
                params: list = [f"%{q}%", f"%{q}%"]
                sql = (
                    "SELECT t.en, t.cn, t.category, t.dict_id,"
                    "       COALESCE(d.sort_order, 9999) AS prio"
                    "  FROM custom_tags t"
                    "  LEFT JOIN dictionaries d ON d.id = t.dict_id"
                    " WHERE (t.en LIKE ? OR t.cn LIKE ?)"
                )
                if ids is not None:
                    ph = ",".join("?" for _ in ids)
                    sql += f" AND t.dict_id IN ({ph})"
                    params.extend(ids)
                sql += " ORDER BY prio ASC, t.updated_at DESC LIMIT ?"
                params.append(limit)
                rows = conn.execute(sql, params).fetchall()
            return [self._custom_to_item(r) for r in rows]
        except Exception:  # noqa: BLE001
            return []

    def _lookup_custom_en(self, en: str):
        try:
            from . import custom_dict

            with custom_dict._lock, custom_dict._connect() as conn:
                return conn.execute(
                    "SELECT en, cn, category FROM custom_tags WHERE en = ? LIMIT 1", (en,)
                ).fetchone()
        except Exception:  # noqa: BLE001
            return None

    def _lookup_custom_cn(self, cn: str):
        try:
            from . import custom_dict

            with custom_dict._lock, custom_dict._connect() as conn:
                return conn.execute(
                    "SELECT en, cn, category FROM custom_tags WHERE cn = ? LIMIT 20", (cn,)
                ).fetchall()
        except Exception:  # noqa: BLE001
            return []

    def search(self, q: str, limit: int = 30) -> list[dict]:
        """中英文同查；自定义词库优先，其后按 post_count DESC。"""
        q = (q or "").strip()
        if not q:
            return []
        if not self.available:
            return self._search_custom(q, limit)

        # ★ 缓存 key 必须包含**词库顺序与启用状态** ★
        # 否则用户调整优先级后，旧结果会被缓存命中，顺序变化看不出来。
        try:
            from . import custom_dict

            _sig = tuple(custom_dict.enabled_dict_ids())
        except Exception:  # noqa: BLE001
            _sig = ()
        key = (q, limit, True, _sig)  # True = 已过滤元数据
        now = time.time()
        with self._lock:
            hit = self._cache.get(key)
            if hit and now - hit[0] < self._cache_ttl:
                return hit[1]

        results: list[dict] = []
        try:
            with self._connect() as conn:
                if _has_cjk(q):
                    # 中文：子串匹配（FTS5 unicode61 不分中文词，直接 LIKE 足矣，
                    # 33 万行实测约 80~150ms，命中缓存后无感）
                    # category=5（元数据：bad_id / highres / c: 等）对生图无意义，直接过滤
                    sql = (
                        "SELECT name, category, cn_name, post_count FROM tags "
                        "WHERE cn_name LIKE ? AND category != 13 "
                        "ORDER BY post_count DESC LIMIT ?"
                    )
                    rows = conn.execute(sql, (f"%{q}%", limit)).fetchall()
                else:
                    # 英文：前缀优先，其次包含
                    sql = (
                        "SELECT name, category, cn_name, post_count FROM tags "
                        "WHERE name LIKE ? AND category != 13 "
                        "ORDER BY (name LIKE ?) DESC, post_count DESC LIMIT ?"
                    )
                    rows = conn.execute(sql, (f"%{q}%", f"{q}%", limit)).fetchall()
                results = [self._row_to_item(r) for r in rows]
        except Exception:  # noqa: BLE001
            results = []

        # ★ 内置词库是否启用 ★
        # 用户要求内置库也能禁用：禁用后只用自定义词库。
        builtin_enabled = True
        try:
            from . import custom_dict

            builtin_enabled = custom_dict.BUILTIN_ID in custom_dict.enabled_dict_ids()
        except Exception:  # noqa: BLE001
            builtin_enabled = True
        if not builtin_enabled:
            results = []

        # 质量词匹配（这些词不在 Danbooru 词库里，是模型侧约定）
        ql = q.lower()
        quality_hits = []
        for qt in QUALITY_TAGS:
            # ★ 两侧都转小写再比 ★
            # 集合里有 "UHD" 这种含大写的词，只把查询词 lower
            # 会导致 "uhd" in "UHD" 为 False 而漏匹配。
            qen = qt["en"].lower()
            qcn = qt["cn"].lower()
            if ql in qen or qen.startswith(ql) or ql in qcn:
                quality_hits.append({
                    "en": qt["en"],
                    "cn": qt["cn"],
                    "category": 5,          # 与 21 类体系一致（曾是 90，历史遗留）
                    "category_key": "quality",
                    "category_label": "质量词",
                    "post_count": 10 ** 11,   # 置于常规标签之上
                    "has_cn": True,
                    "source": "builtin",
                })
        quality_hits = quality_hits[:5]

        # ★ 合并顺序由**词库顺序**决定 ★
        # 自定义词库与内置词库谁排前面，取决于用户在管理页里的排序。
        # 这实现了"词库顺序决定智能提示优先级"。
        custom = self._search_custom(q, limit)
        custom_keys = {(c["en"], c["cn"]) for c in custom}
        quality_keys = {(c["en"], c["cn"]) for c in quality_hits}
        rest = [r for r in results if (r["en"], r["cn"]) not in custom_keys
                and (r["en"], r["cn"]) not in quality_keys]

        builtin_first = False
        try:
            from . import custom_dict

            ids = custom_dict.enabled_dict_ids()
            if ids and ids[0] == custom_dict.BUILTIN_ID:
                builtin_first = True
        except Exception:  # noqa: BLE001
            builtin_first = False

        if builtin_first:
            merged = (quality_hits + rest + custom)[:limit]
        else:
            merged = (custom + quality_hits + rest)[:limit]

        # 同名词去重：保留**最先出现**的那个（即优先级最高的词库）
        seen: set = set()
        dedup: list[dict] = []
        for item in merged:
            k = (item.get("en", ""), item.get("cn", ""))
            if k in seen:
                continue
            seen.add(k)
            dedup.append(item)
        merged = dedup[:limit]

        with self._lock:
            self._cache[key] = (now, merged)
            if len(self._cache) > 512:
                oldest = sorted(self._cache.items(), key=lambda kv: kv[1][0])[:128]
                for k, _ in oldest:
                    self._cache.pop(k, None)
        return merged

    def _quality_hit(self, en: str) -> dict | None:
        """按英文查内置质量词集合（大小写不敏感）。

        masterpiece / best quality 这类词不在 Danbooru 词库里，
        但搜索和 lookup 都要能命中 —— 否则会被当成"未收录"。
        """
        if not en:
            return None
        q = en.strip().lower()
        for qt in QUALITY_TAGS:
            if q == qt["en"].lower():
                return {
                    "en": qt["en"],
                    "cn": qt["cn"],
                    "category": 5,
                    "category_key": "quality",
                    "category_label": "质量词",
                    "post_count": 10 ** 11,
                    "has_cn": True,
                    "source": "builtin",
                }
        return None

    def lookup_en(self, en: str) -> dict | None:
        """按英文**完全匹配**查（不做子串匹配）。

        归一化：忽略大小写、下划线/空格等价（"Long Hair" == "long_hair"）。
        ⚠️ 绝不退化成 LIKE '%x%' —— 那会把 "hair" 匹配到 "long_hair"，
        曲解词义（翻译时尤其致命）。
        """
        if not en:
            return None
        row = self._lookup_custom_en(en.strip())
        if row is not None:
            return self._custom_to_item(row)
        # ★ 内置质量词兜底 ★
        q = self._quality_hit(en)
        if q is not None:
            return q
        if not self.available:
            return None
        try:
            with self._connect() as conn:
                # 归一化比较：两边都 lower 并把下划线当空格
                row = conn.execute(
                    "SELECT name, category, cn_name, post_count FROM tags"
                    " WHERE LOWER(REPLACE(name, '_', ' ')) = LOWER(REPLACE(?, '_', ' '))"
                    "   AND category != 13 LIMIT 1",
                    (en.strip(),),
                ).fetchone()
            return self._row_to_item(row) if row else None
        except Exception:  # noqa: BLE001
            return None

    def lookup_cn(self, cn: str) -> list[dict]:
        """按中文精确查（可能多命中，按 post_count DESC）；自定义优先。"""
        if not cn:
            return []
        custom = [self._custom_to_item(r) for r in self._lookup_custom_cn(cn.strip())]
        if not self.available:
            return custom
        try:
            with self._connect() as conn:
                rows = conn.execute(
                    "SELECT name, category, cn_name, post_count FROM tags "
                    "WHERE cn_name = ? AND category != 13"
                    " ORDER BY post_count DESC LIMIT 20",
                    (cn.strip(),),
                ).fetchall()
            builtin = [self._row_to_item(r) for r in rows]
        except Exception:  # noqa: BLE001
            builtin = []
        seen = {(c["en"], c["cn"]) for c in custom}
        return custom + [b for b in builtin if (b["en"], b["cn"]) not in seen]


_LEXICON: Lexicon | None = None


def update_builtin_categories(pairs: list[tuple[str, int]], backup: bool = True) -> dict:
    """直接修改内置词库（tag.sqlite）里若干标签的分类。

    ⚠️ 这是**写操作**，会改动随插件分发的 tag.sqlite。
    需求方明确要求"改内置词库里的词时直接改"（开发文档 §12X）。
    写前自动备份（同目录 .bak.cat<时间戳>），避免误操作无法恢复。

    pairs: [(标签名, 新分类id), ...]
    """
    import shutil
    import time as _t

    lx = get_lexicon()
    if not lx.available or not lx.db_path:
        return {"ok": False, "error": "内置词库不可用"}
    if not isinstance(pairs, list) or not pairs:
        return {"ok": False, "error": "没有要更新的标签"}

    # 过滤出合法的分类 id
    valid = []
    for name, cat in pairs:
        try:
            c = int(cat)
        except (TypeError, ValueError):
            continue
        if c not in CATEGORY_META:
            continue
        valid.append((str(name), c))
    if not valid:
        return {"ok": False, "error": "没有合法的分类值"}

    bak = None
    if backup:
        bak = f"{lx.db_path}.bak.cat{int(_t.time())}"
        try:
            shutil.copy2(lx.db_path, bak)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"备份失败：{e}"}

    try:
        conn = sqlite3.connect(lx.db_path, check_same_thread=False)
        conn.execute("BEGIN")
        # cat2 是分类体系换代时的对照列，保持一致
        conn.executemany(
            "UPDATE tags SET category=?, cat2=? WHERE name=?",
            [(c, c, n) for n, c in valid],
        )
        conn.commit()
        changed = conn.total_changes
        conn.close()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"写入失败：{e}", "backup": bak}

    # 清掉搜索缓存，否则改完分类要等 60 秒 TTL 才生效
    with lx._lock:
        lx._cache.clear()
    return {"ok": True, "updated": changed, "backup": bak}


def get_lexicon() -> Lexicon:
    global _LEXICON
    if _LEXICON is None:
        _LEXICON = Lexicon()
    return _LEXICON
