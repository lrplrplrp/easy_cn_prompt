"""词库管理：多词库 + 顺序 + 启用开关。

设计（见开发文档 §9.2）：
  · 独立 SQLite 文件，不污染内置 tag.sqlite
  · **dictionaries 表**记录每个词库的元信息（名称、顺序、是否启用）
  · **custom_tags 表**存词条，用 dict_id 关联到词库
  · 内置的 Danbooru 词库作为一条「虚拟」记录（id=0，不可删除），
    也参与排序与启用/禁用 —— 用户明确要求内置库同样可禁用、可排序
  · **顺序决定智能提示优先级**：排在前面的词库，同名词优先返回

旧版本只有一张 custom_tags 表（无 dict 概念）。
本模块在首次连接时自动迁移：把旧数据全部归入「默认」词库。
"""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time

_PLUGIN_ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
DATA_DIR = os.path.join(_PLUGIN_ROOT, "data")
DB_PATH = os.path.join(DATA_DIR, "custom_dict.db")

# 内置 Danbooru 词库的虚拟 id（不存 custom_tags）
BUILTIN_ID = 0

# 全部类别 id（与 lexicon/db.py 的 CATEGORY_META 对应）
CATEGORY_IDS = list(range(0, 22))
BUILTIN_NAME = "内置 Danbooru 词库"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS dictionaries (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled    INTEGER NOT NULL DEFAULT 1,
    is_builtin INTEGER NOT NULL DEFAULT 0,
    -- is_default=1 表示"一键收录"的目标词库。
    -- 由用户在词库管理里指定；**不自动选**——没设时一键收录不可用。
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- 通用配置（键值对）：类型排序等设置存这里
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_tags (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    dict_id    INTEGER NOT NULL DEFAULT 1,
    en         TEXT NOT NULL,
    cn         TEXT NOT NULL,
    category   INTEGER DEFAULT 0,
    note       TEXT DEFAULT '',
    post_count INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(dict_id, en, cn)
);
"""
# 注意：索引不在 _SCHEMA 里建。旧版本的表没有 dict_id 列，
# 先 CREATE INDEX ... (dict_id) 会在迁移前就报 "no such column"。
# 统一放到 _migrate() 完成之后建。

_lock = threading.Lock()
_initialized = False


def _migrate(conn: sqlite3.Connection) -> None:
    """把旧版结构迁移到当前结构。"""
    # dictionaries 补 is_default 列（老库没有）
    dcols = {r[1] for r in conn.execute("PRAGMA table_info(dictionaries)")}
    if dcols and "is_default" not in dcols:
        conn.execute("ALTER TABLE dictionaries ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0")

    cols = {r[1] for r in conn.execute("PRAGMA table_info(custom_tags)")}
    if "dict_id" not in cols:
        # 旧表没有 dict_id：加列，并把旧数据归入「默认」词库
        conn.execute("ALTER TABLE custom_tags ADD COLUMN dict_id INTEGER NOT NULL DEFAULT 1")
    # 旧表是 UNIQUE(en, cn)，需要换成 UNIQUE(dict_id, en, cn)。
    # SQLite 不能直接改约束，检查旧索引是否还在，在的话重建表。
    idx_sql = [
        r[0] or ""
        for r in conn.execute("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='custom_tags'")
    ]
    tbl_sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='custom_tags'"
    ).fetchone()
    need_rebuild = bool(tbl_sql and "UNIQUE(dict_id, en, cn)" not in (tbl_sql[0] or ""))
    if need_rebuild:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS custom_tags_new (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                dict_id    INTEGER NOT NULL DEFAULT 1,
                en         TEXT NOT NULL,
                cn         TEXT NOT NULL,
                category   INTEGER DEFAULT 0,
                note       TEXT DEFAULT '',
                post_count INTEGER DEFAULT 0,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                UNIQUE(dict_id, en, cn)
            );
            INSERT OR IGNORE INTO custom_tags_new
                (id, dict_id, en, cn, category, note, post_count, created_at, updated_at)
                SELECT id, COALESCE(dict_id, 1), en, cn,
                       COALESCE(category, 0), COALESCE(note, ''),
                       COALESCE(post_count, 0), created_at, updated_at
                FROM custom_tags;
            DROP TABLE custom_tags;
            ALTER TABLE custom_tags_new RENAME TO custom_tags;
            CREATE INDEX IF NOT EXISTS idx_custom_en ON custom_tags(en);
            CREATE INDEX IF NOT EXISTS idx_custom_cn ON custom_tags(cn);
            CREATE INDEX IF NOT EXISTS idx_custom_dict ON custom_tags(dict_id);
        """)


def _ensure_builtin(conn: sqlite3.Connection) -> None:
    """确保内置词库与「默认」词库存在。"""
    now = int(time.time())
    row = conn.execute("SELECT id FROM dictionaries WHERE id=?", (BUILTIN_ID,)).fetchone()
    if not row:
        conn.execute(
            "INSERT INTO dictionaries (id, name, sort_order, enabled, is_builtin, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?)",
            (BUILTIN_ID, BUILTIN_NAME, 0, 1, 1, now, now),
        )
    # 若一个用户词库都没有，建一个「默认」
    n = conn.execute("SELECT COUNT(*) FROM dictionaries WHERE is_builtin=0").fetchone()[0]
    if n == 0:
        conn.execute(
            "INSERT INTO dictionaries (name, sort_order, enabled, is_builtin, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?)",
            ("默认", 1, 1, 0, now, now),
        )


def _connect() -> sqlite3.Connection:
    global _initialized
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    if not _initialized:
        _migrate(conn)
        _ensure_builtin(conn)
        _initialized = True
    else:
        _ensure_builtin(conn)
    # 迁移完成后再建索引（此时 dict_id 一定存在）
    conn.executescript("""
        CREATE INDEX IF NOT EXISTS idx_custom_en ON custom_tags(en);
        CREATE INDEX IF NOT EXISTS idx_custom_cn ON custom_tags(cn);
        CREATE INDEX IF NOT EXISTS idx_custom_dict ON custom_tags(dict_id);
    """)
    conn.commit()
    return conn


# --------------------------------------------------------------------------
# 词库管理
# --------------------------------------------------------------------------

def list_dicts() -> list[dict]:
    """列出全部词库（含内置），按顺序排。附带词条数。"""
    with _lock, _connect() as conn:
        rows = conn.execute(
            "SELECT id, name, sort_order, enabled, is_builtin, is_default FROM dictionaries"
            " ORDER BY sort_order ASC, id ASC"
        ).fetchall()
        counts = {
            r[0]: r[1]
            for r in conn.execute("SELECT dict_id, COUNT(*) FROM custom_tags GROUP BY dict_id")
        }
    out = []
    for r in rows:
        d = dict(r)
        d["enabled"] = bool(d["enabled"])
        d["is_builtin"] = bool(d["is_builtin"])
        d["is_default"] = bool(d.get("is_default", 0))
        d["count"] = counts.get(d["id"], 0)
        out.append(d)
    return out


def enabled_dict_ids() -> list[int]:
    """当前启用的词库 id，按优先级（顺序）排列。"""
    return [d["id"] for d in list_dicts() if d["enabled"]]


def create_dict(name: str) -> dict:
    name = (name or "").strip()
    if not name:
        return {"ok": False, "error": "名称不能为空"}
    now = int(time.time())
    with _lock, _connect() as conn:
        dup = conn.execute("SELECT id FROM dictionaries WHERE name=?", (name,)).fetchone()
        if dup:
            return {"ok": False, "error": "已存在同名词库"}
        mx = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM dictionaries").fetchone()[0]
        cur = conn.execute(
            "INSERT INTO dictionaries (name, sort_order, enabled, is_builtin, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?)",
            (name, mx + 1, 1, 0, now, now),
        )
        return {"ok": True, "id": cur.lastrowid, "name": name}


def rename_dict(dict_id: int, name: str) -> dict:
    name = (name or "").strip()
    if not name:
        return {"ok": False, "error": "名称不能为空"}
    with _lock, _connect() as conn:
        row = conn.execute("SELECT is_builtin FROM dictionaries WHERE id=?", (dict_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "词库不存在"}
        if row["is_builtin"]:
            return {"ok": False, "error": "内置词库不可重命名"}
        dup = conn.execute(
            "SELECT id FROM dictionaries WHERE name=? AND id<>?", (name, dict_id)
        ).fetchone()
        if dup:
            return {"ok": False, "error": "已存在同名词库"}
        conn.execute(
            "UPDATE dictionaries SET name=?, updated_at=? WHERE id=?",
            (name, int(time.time()), dict_id),
        )
        return {"ok": True, "id": dict_id, "name": name}


def set_enabled(dict_id: int, enabled: bool) -> dict:
    with _lock, _connect() as conn:
        row = conn.execute("SELECT id FROM dictionaries WHERE id=?", (dict_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "词库不存在"}
        conn.execute(
            "UPDATE dictionaries SET enabled=?, updated_at=? WHERE id=?",
            (1 if enabled else 0, int(time.time()), dict_id),
        )
        return {"ok": True, "id": dict_id, "enabled": bool(enabled)}


def delete_dict(dict_id: int) -> dict:
    """删除词库（连同其中词条）。内置词库不可删。"""
    with _lock, _connect() as conn:
        row = conn.execute("SELECT is_builtin, name FROM dictionaries WHERE id=?", (dict_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "词库不存在"}
        if row["is_builtin"]:
            return {"ok": False, "error": "内置词库不可删除"}
        n = conn.execute("SELECT COUNT(*) FROM dictionaries WHERE is_builtin=0").fetchone()[0]
        if n <= 1:
            return {"ok": False, "error": "至少要保留一个自定义词库"}
        conn.execute("DELETE FROM custom_tags WHERE dict_id=?", (dict_id,))
        conn.execute("DELETE FROM dictionaries WHERE id=?", (dict_id,))
        return {"ok": True, "id": dict_id}


# 自动分类的置信度阈值：≥ 此值才直接采纳，否则保留「待确认」
CONF_KEY = "classify_confidence"
CONF_DEFAULT = 0.8


def get_confidence() -> float:
    """取分类置信度阈值。范围 0~0.99（0 = 全部采纳）。"""
    with _lock, _connect() as conn:
        r = conn.execute("SELECT value FROM settings WHERE key=?", (CONF_KEY,)).fetchone()
    if not r:
        return CONF_DEFAULT
    try:
        v = float(r["value"])
    except (TypeError, ValueError):
        return CONF_DEFAULT
    return min(0.99, max(0.0, v))


def set_confidence(value: float) -> dict:
    """设置置信度阈值（0~0.99，0 表示全部采纳）。"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return {"ok": False, "error": "数值不合法"}
    v = min(0.99, max(0.0, v))
    with _lock, _connect() as conn:
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (CONF_KEY, str(v), int(time.time())),
        )
    return {"ok": True, "confidence": v}


# 「待确认」永远排在最后（它是机器分类的中间态，不该插在正常类型之间）
PENDING_CAT = 21
CAT_ORDER_KEY = "category_order"


# ★ 默认类型顺序：按 Anima 官方提示词格式（Animagine XL 4.0 README）★
#   质量词 → Meta/形式 → 画师 → 角色(含人数) → 系列名(版权)
#   → 其余描述类型（官方"any order"，这里按常见提示词习惯）→ 其他 → 待确认
# 用户可在「设置」里改；改坏了可一键恢复到这个顺序。
ANIMA_DEFAULT_ORDER = [
    5,    # 质量词（masterpiece / best quality / score_9 / newest 等开头）
    13,   # 形式（highres / official art 等元信息）
    1,    # 艺术家（画师）
    4,    # 角色（1girl / 角色名）
    3,    # 版权/作品（系列名）
    2,    # 风格
    7,    # 头发
    6,    # 头饰
    8,    # 眼睛
    9,    # 耳朵
    10,   # 表情
    11,   # 姿势
    17,   # 服装
    18,   # 配饰
    20,   # 身体特征
    16,   # 画面效果
    14,   # 镜头
    15,   # 视角
    12,   # 背景
    19,   # 道具
    0,    # 其他
    21,   # 待确认（永远最后）
]


def get_category_order() -> list[int]:
    """取用户设定的类型顺序。

    未设置时返回 **Anima 官方顺序**（ANIMA_DEFAULT_ORDER）。
    返回值**保证** 待确认(21) 在最后。
    """
    with _lock, _connect() as conn:
        r = conn.execute("SELECT value FROM settings WHERE key=?", (CAT_ORDER_KEY,)).fetchone()
    full = list(ANIMA_DEFAULT_ORDER)
    full = [c for c in full if c != PENDING_CAT]

    if r:
        try:
            saved = [int(x) for x in json.loads(r["value"])]
            # 只保留合法的、去重；未出现的补到末尾
            seen = set()
            out = []
            for c in saved:
                if c in full and c not in seen:
                    seen.add(c)
                    out.append(c)
            for c in full:
                if c not in seen:
                    out.append(c)
            full = out
        except Exception:  # noqa: BLE001
            pass
    full.append(PENDING_CAT)      # ★ 永远最后
    return full


def set_category_order(order: list[int]) -> dict:
    """保存类型顺序。待确认会被强制挪到最后。

    order 为空 → 删除已保存的设置，回到 Anima 官方默认顺序。
    """
    if not isinstance(order, list) or not order:
        with _lock, _connect() as conn:
            conn.execute("DELETE FROM settings WHERE key=?", (CAT_ORDER_KEY,))
        return {"ok": True, "order": get_category_order(), "reset": True}
    clean = []
    seen = set()
    for x in order:
        try:
            c = int(x)
        except (TypeError, ValueError):
            continue
        if c in CATEGORY_IDS and c != PENDING_CAT and c not in seen:
            seen.add(c)
            clean.append(c)
    with _lock, _connect() as conn:
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?,?,?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (CAT_ORDER_KEY, json.dumps(clean), int(time.time())),
        )
    return {"ok": True, "order": get_category_order()}


def set_default_dict(dict_id: int | None) -> dict:
    """设置「一键收录」的目标词库；传 None/0 表示取消默认。

    ⚠️ 默认词库是**用户主动选**的，不自动指定。
    未设置时一键收录不可用。
    """
    now = int(time.time())
    with _lock, _connect() as conn:
        if dict_id:
            row = conn.execute("SELECT id, is_builtin FROM dictionaries WHERE id=?",
                               (int(dict_id),)).fetchone()
            if not row:
                return {"ok": False, "error": "词库不存在"}
            if row["is_builtin"]:
                return {"ok": False, "error": "内置词库不能作为收录目标"}
        conn.execute("UPDATE dictionaries SET is_default=0")
        if dict_id:
            conn.execute("UPDATE dictionaries SET is_default=1, updated_at=? WHERE id=?",
                         (now, int(dict_id)))
        return {"ok": True, "default_id": int(dict_id) if dict_id else None}


def get_default_dict() -> dict | None:
    """取默认词库；没有则返回 None。"""
    with _lock, _connect() as conn:
        r = conn.execute(
            "SELECT id, name, enabled FROM dictionaries WHERE is_default=1 LIMIT 1"
        ).fetchone()
    return dict(r) if r else None


def reorder_dicts(ordered_ids: list[int]) -> dict:
    """按传入的 id 顺序重排词库。顺序决定智能提示优先级。"""
    if not isinstance(ordered_ids, list) or not ordered_ids:
        return {"ok": False, "error": "顺序不能为空"}
    now = int(time.time())
    with _lock, _connect() as conn:
        for i, did in enumerate(ordered_ids):
            conn.execute(
                "UPDATE dictionaries SET sort_order=?, updated_at=? WHERE id=?",
                (i, now, int(did)),
            )
        return {"ok": True, "order": ordered_ids}


# --------------------------------------------------------------------------
# 词条操作
# --------------------------------------------------------------------------

def save(en: str, cn: str, category: int = 0, note: str = "",
         dict_id: int = 1, dict_name: str = "") -> dict:
    en = (en or "").strip()
    cn = (cn or "").strip()
    if not en:
        return {"ok": False, "error": "英文内容不能为空"}
    if not cn:
        cn = en
    now = int(time.time())
    with _lock, _connect() as conn:
        # 允许按名称指定词库（前端子菜单直接给名字）
        if dict_name and not dict_id:
            row = conn.execute("SELECT id FROM dictionaries WHERE name=?", (dict_name,)).fetchone()
            if row:
                dict_id = row["id"]
        if not dict_id:
            dict_id = 1
        row = conn.execute("SELECT id FROM dictionaries WHERE id=?", (dict_id,)).fetchone()
        if not row:
            return {"ok": False, "error": "目标词库不存在"}
        conn.execute(
            "INSERT INTO custom_tags (dict_id, en, cn, category, note, post_count, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?)"
            " ON CONFLICT(dict_id, en, cn) DO UPDATE SET"
            "   category=excluded.category, note=excluded.note, updated_at=excluded.updated_at",
            (int(dict_id), en, cn, int(category), note, 0, now, now),
        )
    return {"ok": True, "en": en, "cn": cn, "category": int(category), "dict_id": int(dict_id)}


def list_all(limit: int = 5000, dict_id: int | None = None) -> list[dict]:
    sql = ("SELECT t.id, t.dict_id, t.en, t.cn, t.category, t.created_at,"
           "       d.name AS dict_name"
           "  FROM custom_tags t LEFT JOIN dictionaries d ON d.id = t.dict_id")
    args: list = []
    if dict_id is not None:
        sql += " WHERE t.dict_id = ?"
        args.append(int(dict_id))
    sql += " ORDER BY t.updated_at DESC LIMIT ?"
    args.append(limit)
    with _lock, _connect() as conn:
        rows = conn.execute(sql, args).fetchall()
    return [dict(r) for r in rows]


def delete(en: str = "", cn: str = "", dict_id: int | None = None) -> dict:
    """删除词条。

    ⚠️ en 必须非空 —— 防止前端漏传字段导致整库误删。
    """
    en = (en or "").strip()
    cn = (cn or "").strip()
    if not en:
        return {"ok": False, "error": "缺少 en 参数（拒绝模糊删除）"}

    conds: list[str] = ["en = ?"]
    args: list = [en]
    if cn:
        conds.append("cn = ?")
        args.append(cn)
    if dict_id is not None:
        conds.append("dict_id = ?")
        args.append(int(dict_id))
    sql = "DELETE FROM custom_tags WHERE " + " AND ".join(conds)

    with _lock, _connect() as conn:
        cur = conn.execute(sql, args)
        return {"ok": True, "deleted": cur.rowcount}


def count(dict_id: int | None = None) -> int:
    try:
        with _lock, _connect() as conn:
            if dict_id is None:
                return conn.execute("SELECT COUNT(*) FROM custom_tags").fetchone()[0]
            return conn.execute(
                "SELECT COUNT(*) FROM custom_tags WHERE dict_id=?", (int(dict_id),)
            ).fetchone()[0]
    except Exception:  # noqa: BLE001
        return 0


# --------------------------------------------------------------------------
# 导入 / 导出
# --------------------------------------------------------------------------

def export_dict(dict_id: int) -> dict:
    """导出某个词库为 JSON 结构。"""
    with _lock, _connect() as conn:
        d = conn.execute("SELECT name FROM dictionaries WHERE id=?", (dict_id,)).fetchone()
        if not d:
            return {"ok": False, "error": "词库不存在"}
        rows = conn.execute(
            "SELECT en, cn, category, note FROM custom_tags WHERE dict_id=? ORDER BY en",
            (int(dict_id),),
        ).fetchall()
    return {
        "ok": True,
        "name": d["name"],
        "version": 1,
        "tags": [dict(r) for r in rows],
    }


def import_dict(payload: dict | str, target_name: str = "") -> dict:
    """导入词库。

    支持两种输入：
      · dict / JSON 字符串：{"name": "...", "tags": [{"en","cn","category"}]}
      · CSV 文本："en,cn[,category]" 每行一条
    """
    tags: list[dict] = []
    name = (target_name or "").strip()

    if isinstance(payload, str):
        txt = payload.strip()
        if txt.startswith("{"):
            try:
                payload = json.loads(txt)
            except Exception:  # noqa: BLE001
                return {"ok": False, "error": "JSON 解析失败"}
        else:
            payload = {"tags": _parse_csv(txt)}

    if isinstance(payload, dict):
        name = name or (payload.get("name") or "").strip() or "导入的词库"
        raw = payload.get("tags") or payload.get("items") or []
        for it in raw:
            if not isinstance(it, dict):
                continue
            en = str(it.get("en") or "").strip()
            if not en:
                continue
            tags.append({
                "en": en,
                "cn": str(it.get("cn") or en).strip(),
                "category": int(it.get("category") or 0),
                "note": str(it.get("note") or ""),
            })
    else:
        return {"ok": False, "error": "无法识别的导入格式"}

    if not tags:
        return {"ok": False, "error": "没有解析到任何词条"}

    # 建库（重名则自动加后缀）
    base = name
    i = 2
    while True:
        res = create_dict(name)
        if res.get("ok"):
            break
        if "已存在同名" in (res.get("error") or ""):
            name = f"{base} ({i})"
            i += 1
            if i > 50:
                return {"ok": False, "error": "无法创建词库（重名过多）"}
        else:
            return res

    did = res["id"]
    now = int(time.time())
    with _lock, _connect() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO custom_tags"
            " (dict_id, en, cn, category, note, post_count, created_at, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            [(did, t["en"], t["cn"], t["category"], t["note"], 0, now, now) for t in tags],
        )
    return {"ok": True, "id": did, "name": name, "imported": len(tags)}


def _parse_csv(txt: str) -> list[dict]:
    out: list[dict] = []
    for line in txt.splitlines():
        line = line.strip()
        if not line or line.lower().startswith("en,"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if not parts or not parts[0]:
            continue
        cat = 0
        if len(parts) > 2:
            try:
                cat = int(parts[2])
            except ValueError:
                cat = 0
        out.append({
            "en": parts[0],
            "cn": parts[1] if len(parts) > 1 and parts[1] else parts[0],
            "category": cat,
            "note": "",
        })
    return out
