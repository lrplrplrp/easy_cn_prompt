#!/usr/bin/env python3
"""把新分类体系导入 tag.sqlite。

分类结果来自两个来源：
  1. data/tag_category_map.json  —— 人工/AI 精修的精确映射（优先）
  2. RULES                       —— 词形正则兜底

原分类直接映射：
  category 1 → 1 艺术家
  category 4 → 4 角色
  category 3 → 3 版权/作品
  category 5 → 5 质量词
  category 0 → 需要重新分类

用法：
  python tools/apply_categories.py --dry-run   # 只统计，不写库
  python tools/apply_categories.py             # 实际写入（先自动备份）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sqlite3
import time

ROOT = os.path.dirname(os.path.dirname(os.path.realpath(__file__)))
DB = os.path.join(ROOT, "ffdkj-Danbooru_Tag-Chinese-English-Translation-Table",
                  "tag.sqlite")
MAP_FILE = os.path.join(ROOT, "data", "tag_category_map.json")

# 类别 ID（与 分类体系.md 一致）
CAT_OTHER = 0
CAT_ARTIST = 1
CAT_STYLE = 2
CAT_COPYRIGHT = 3
CAT_CHARACTER = 4
CAT_QUALITY = 5
CAT_HEADWEAR = 6
CAT_HAIR = 7
CAT_EYES = 8
CAT_EARS = 9
CAT_EXPRESSION = 10
CAT_POSE = 11
CAT_BACKGROUND = 12
CAT_FORM = 13
CAT_SHOT = 14
CAT_VIEW = 15
CAT_EFFECT = 16

# 原分类 → 新分类
LEGACY_MAP = {1: CAT_ARTIST, 3: CAT_COPYRIGHT, 4: CAT_CHARACTER, 5: CAT_QUALITY}

# ── 词形正则兜底规则 ──
# 顺序即优先级：先匹配到的类别胜出。
RULES: list[tuple[int, str]] = [
    # 头发（发型）
    (CAT_HAIR, r"(?:^|_)hair(?:$|_)|hair$|twintails?$|ponytail|braids?$|bangs|ahoge|"
               r"hime_cut|bob_cut|drill_hair|hair_between_eyes|multicolored_hair|"
               r"gradient_hair|streaked_hair|sidelocks|hair_intakes|"
               r"wavy_hair|curly_hair|straight_hair|messy_hair|flipped_hair"),
    # 眼睛
    (CAT_EYES, r"eyes?$|_eyes?$|_eyes?_|iris$|pupils?$|eyelashes|eyebrows?$|"
               r"heterochromia|sclera|eyeball|eye_"),
    # 耳朵（仅本体）
    (CAT_EARS, r"ears?$|_ears?$|_ears?_|ear$"),
    # 头饰
    (CAT_HEADWEAR, r"hat$|_hat|hats$|cap$|_cap$|bonnet|helmet|headband|hairband|"
                   r"hairpin|hair_ornament|hair_ribbon|hair_bow|hair_flower|"
                   r"tiara|crown|veil|hood|beret|bow$|_bow$|ribbon$|_ribbon|"
                   r"hat_tip|witch_hat|santa_hat|nurse_cap|maid_headdress|"
                   r"shrine_maiden_headdress|goggles_on_head|headphones|"
                   r"hair_scrunchie|scrunchie|hair_clips?|kanzashi|headdress"),
    # 表情
    (CAT_EXPRESSION, r"smile|smirk|grin$|frown|pout|crying|tears$|teary|"
                     r"angry|surprised|expression$|_expression|blush|"
                     r"open_mouth|closed_mouth|parted_lips|licking_lips|"
                     r"embarrassed|shy$|smug|wink$|one_eye_closed|rolling_eyes|"
                     r"naughty_face|torogao|ahegao|screaming|yelling|"
                     r"nose_blush|sweatdrop|^sweat$|drooling|tongue_out"),
    # 姿势
    (CAT_POSE, r"standing|sitting|lying|kneeling|crouching|squatting|walking|"
               r"running|jumping|leaning|^pose$|_pose$|^arms?_|_arms?$|"
               r"^legs?_|_legs?$|^hands?_|_hands?$|holding|hugging|carrying|"
               r"crossed_arms|crossed_legs|spread_legs|hands_up|hands_on|"
               r"hand_on_hip|arms_behind|arms_at_sides|sleeping|stretching|"
               r"dancing|bending|tiptoes|on_back|on_stomach|on_side|"
               r"fetal_position|wariza|seiza|indian_style"),
    # 视角（方向）
    (CAT_VIEW, r"^from_(?:above|below|behind|side|outside|front)|_view$|"
               r"viewer$|looking_at_viewer|^pov|pov$|_pov|eye_contact|"
               r"facing_viewer|facing_away|facing_forward|turning_around|"
               r"three_quarter_view|profile$|^back$|from_the_side|"
               r"upside_down|rotated"),
    # 镜头（景别）
    (CAT_SHOT, r"close.?up|^closeup|cowboy_shot|^portrait$|_portrait|"
               r"full_body|upper_body|lower_body|^full-length|"
               r"feet_out_of_frame|head_out_of_frame|^wide_shot|"
               r"^medium_shot|^long_shot|^establishing_shot|"
               r"^bust$|^waist_up|^thigh_focus|^face_focus|"
               r"^face$|^head$|^torso$|^foot_focus|^hand_focus"),
    # 背景
    (CAT_BACKGROUND, r"background|scenery|^sky$|_sky$|clouds?$|_clouds|"
                     r"^tree|_tree|_trees$|^flowers?$|_flowers?$|^water$|"
                     r"^sea$|^ocean$|^beach$|^river$|^lake$|^rain$|^snow$|"
                     r"indoors?$|outdoors?$|^window$|_window|^room$|^bed$|"
                     r"_bed$|^chair$|^desk$|^floor$|_floor|^wall$|_wall$|"
                     r"^building|^city|^street|^forest|^mountain|^garden|"
                     r"^classroom|^bedroom|^kitchen|^bathroom|^onsen|"
                     r"^night$|^day$|^sunset$|^sunrise$|^daytime$|"
                     r"^star(?:s|ry)|^moon$|^sun$|^starry_sky|"
                     r"^ruins$|^cherry_blossoms|^field$|^grass|^sand$"),
    # 形式（体裁）
    (CAT_FORM, r"^comic$|^manga$|^4koma$|^doujinshi$|^sketch$|^lineart$|"
               r"^greyscale$|^monochrome$|^border$|^letterboxed$|"
               r"^speech_bubble$|^thought_bubble$|^translated$|"
               r"^english_text$|^japanese_text$|^chinese_text$|"
               r"^dialogue$|^text$|^watermark$|^signature$|^artist_name$|"
               r"^web_address$|^dated$|^commentary$|^bad_id$|^bad_twitter_id$|"
               r"^absurdres$|^highres$|^lowres$|^novelty$|^mosaic_censoring$|"
               r"^bar_censor$|^censored$|^uncensored$|^animated$|^animated_gif$|"
               r"^multiple_views$|^2koma$|^6\+koma$|^storybook$|^cover$|"
               r"^poster$|^card$|^sticker$|^chibi$"),
    # 风格（画风）
    (CAT_STYLE, r"^realistic$|^semi-realistic|^anime_style|^cartoon$|"
                r"^pixel_art$|^watercolor|^oil_painting|^sketch_style|"
                r"^impression|^art_nouveau|^art_deco|^ukiyo-e|^flat_color|"
                r"^cel_shading|^painterly|^3d$|^3d_style|^cgi$|^photo|"
                r"^photorealistic|^vector_art|^minimalism|^abstract|"
                r"^surreal|^gothic|^cyberpunk|^steampunk|^retro_artstyle|"
                r"^traditional_media|^mixed_media|^trading_card"),
    # 画面效果
    (CAT_EFFECT, r"glowing|glow$|light_particles|^sparkle|_sparkle|"
                 r"depth_of_field|^blurry$|_blur$|motion_blur|"
                 r"chromatic_aberration|^lens_flare|_flare|"
                 r"^vignette|_vignette|^bokeh|_bokeh|^backlighting|"
                 r"^rim_light|^silhouette|_silhouette|^shadow$|_shadow|"
                 r"^reflection|_reflection|^translucent|^transparent|"
                 r"^gradient$|_gradient|^high_contrast|^backlit|"
                 r"^god_rays|^sunbeam|^light_rays|^lens_flare|"
                 r"^afterimage|^motion_lines|^speed_lines|^halftone|"
                 r"^noise$|^film_grain|^glitch"),
]


def load_map() -> dict[str, int]:
    if not os.path.exists(MAP_FILE):
        return {}
    with open(MAP_FILE, encoding="utf-8") as f:
        raw = json.load(f)
    # 允许 {"en": id} 或 {"en": {"cat": id}} 两种写法
    out: dict[str, int] = {}
    for k, v in raw.items():
        if isinstance(v, dict):
            v = v.get("cat")
        if isinstance(v, int):
            out[k] = v
    return out


def classify(name: str, legacy_cat: int, exact: dict[str, int]) -> tuple[int, str]:
    """返回 (新分类, 来源)。"""
    if name in exact:
        return exact[name], "exact"
    if legacy_cat in LEGACY_MAP:
        return LEGACY_MAP[legacy_cat], "legacy"
    for cat, pat in RULES:
        if re.search(pat, name):
            return cat, "rule"
    return CAT_OTHER, "other"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(DB):
        raise SystemExit(f"找不到词库：{DB}")

    exact = load_map()
    print(f"精确映射条数：{len(exact):,}")

    con = sqlite3.connect(DB)
    rows = con.execute("select name, category from tags").fetchall()
    print(f"词库总数：{len(rows):,}")

    new_cats: dict[str, int] = {}
    stat: dict[str, int] = {}
    dist: dict[int, int] = {}
    for name, legacy in rows:
        cat, src = classify(name, legacy, exact)
        new_cats[name] = cat
        stat[src] = stat.get(src, 0) + 1
        dist[cat] = dist.get(cat, 0) + 1

    print()
    print("来源统计：", {k: f"{v:,}" for k, v in sorted(stat.items())})
    print()
    print("新分类分布：")
    names = {0:"其他",1:"艺术家",2:"风格",3:"版权/作品",4:"角色",5:"质量词",
             6:"头饰",7:"头发",8:"眼睛",9:"耳朵",10:"表情",11:"姿势",
             12:"背景",13:"形式",14:"镜头",15:"视角",16:"画面效果"}
    for cat in sorted(dist):
        print(f"  {cat:>2} {names.get(cat,'?'):<10} {dist[cat]:>8,}")

    if args.dry_run:
        print()
        print("（dry-run，未写入）")
        return

    bak = f"{DB}.bak.{int(time.time())}"
    shutil.copy2(DB, bak)
    print(f"\n已备份 → {bak}")

    # 加一列存新分类，保留原 category 以便回滚
    cols = {r[1] for r in con.execute("PRAGMA table_info(tags)")}
    if "cat2" not in cols:
        con.execute("ALTER TABLE tags ADD COLUMN cat2 INTEGER")
    con.executemany("UPDATE tags SET cat2=? WHERE name=?",
                    [(c, n) for n, c in new_cats.items()])
    con.commit()
    print("已写入 cat2 列。")
    print("确认无误后可执行：UPDATE tags SET category=cat2;")


if __name__ == "__main__":
    main()
