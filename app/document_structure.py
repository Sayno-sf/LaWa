"""Office 原生表格/公式/图片结构；不调用模型、不执行文档中的内容。"""
from __future__ import annotations

MATH = "http://schemas.openxmlformats.org/officeDocument/2006/math"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _tag(node):
    return node.tag.rsplit("}", 1)[-1]


def _child(node, name):
    return next((child for child in node if _tag(child) == name), None)


def _val(node, name, default=""):
    props = _child(node, _tag(node) + "Pr")
    child = _child(props, name) if props is not None else None
    return child.get("{" + MATH + "}val", default) if child is not None else default


def math_latex(node, warnings: set[str], depth=0):
    """保留 OMML 的分式/上下标等语义；不支持的结构显式警告，不能悄悄变平。"""
    if node is None:
        return ""
    if depth > 64:
        warnings.add("FORMULA_STRUCTURE_TOO_DEEP")
        return ""
    tag = _tag(node)
    part = lambda name: math_latex(_child(node, name), warnings, depth + 1)
    if tag.endswith("Pr") or tag in ("ctrlPr", "degHide"):
        return ""
    if tag == "t":
        return node.text or ""
    if tag == "f":
        if _val(node, "type", "bar") == "noBar":
            return "\\binom{" + part("num") + "}{" + part("den") + "}"
        if _val(node, "type", "bar") not in ("bar", "skw", "lin"):
            warnings.add("FORMULA_UNSUPPORTED_FRACTION")
        return "\\frac{" + part("num") + "}{" + part("den") + "}"
    if tag in ("sSup", "sSub", "sSubSup", "sPre"):
        suffix = ("_{" + part("sub") + "}" if tag != "sSup" else "") + ("^{" + part("sup") + "}" if tag != "sSub" else "")
        return ("{}" + suffix + part("e")) if tag == "sPre" else "{" + part("e") + "}" + suffix
    if tag == "rad":
        degree = part("deg")
        return "\\sqrt" + ("[" + degree + "]" if degree else "") + "{" + part("e") + "}"
    if tag == "d":
        left, right = _val(node, "begChr", "("), _val(node, "endChr", ")")
        left = "\\{" if left == "{" else left or "."
        right = "\\}" if right == "}" else right or "."
        separator = _val(node, "sepChr", "|")
        separator = "\\middle|" if separator == "|" else separator
        return "\\left" + left + separator.join(math_latex(c, warnings, depth + 1) for c in node if _tag(c) == "e") + "\\right" + right
    if tag == "nary":
        symbol = {"∑": "\\sum", "∏": "\\prod", "∫": "\\int", "∬": "\\iint", "∭": "\\iiint"}.get(_val(node, "chr", "∫"))
        if not symbol:
            warnings.add("FORMULA_UNSUPPORTED_OPERATOR")
            symbol = _val(node, "chr")
        return symbol + ("_{" + part("sub") + "}" if part("sub") else "") + ("^{" + part("sup") + "}" if part("sup") else "") + " " + part("e")
    if tag == "m":
        rows = [" & ".join(math_latex(c, warnings, depth + 1) for c in row if _tag(c) == "e") for row in node if _tag(row) == "mr"]
        return "\\begin{matrix}" + " \\\\ ".join(rows) + "\\end{matrix}"
    if tag == "eqArr":
        return "\\begin{aligned}" + " \\\\ ".join(math_latex(c, warnings, depth + 1) for c in node if _tag(c) == "e") + "\\end{aligned}"
    if tag in ("bar", "acc"):
        if tag == "acc" and _val(node, "chr") not in ("̂", "⃗", "̇", "̈"):
            warnings.add("FORMULA_UNSUPPORTED_ACCENT")
        operator = "\\underline" if tag == "bar" and _val(node, "pos") == "bot" else "\\overline" if tag == "bar" else {"̂": "\\hat", "⃗": "\\vec", "̇": "\\dot", "̈": "\\ddot"}.get(_val(node, "chr"), "\\hat")
        return operator + "{" + part("e") + "}"
    if tag in ("limLow", "limUpp"):
        return "\\" + ("underset" if tag == "limLow" else "overset") + "{" + part("lim") + "}{" + part("e") + "}"
    if tag == "func":
        return "\\operatorname{" + part("fName") + "}" + part("e")
    if tag in ("borderBox", "box"):
        return "\\boxed{" + part("e") + "}" if tag == "borderBox" else part("e")
    if tag not in ("oMath", "oMathPara", "e", "r", "num", "den", "sub", "sup", "deg", "fName", "lim", "mr"):
        warnings.add("FORMULA_UNSUPPORTED_STRUCTURE_" + tag)
    return "".join(math_latex(c, warnings, depth + 1) for c in node)


def office_text(node, warnings: set[str]):
    if node.tag == "{" + MATH + "}oMath":
        local_warnings: set[str] = set()
        value = math_latex(node, local_warnings)
        warnings.update(local_warnings)
        return "\\(" + value + "\\)" + (" [原生公式结构未完全识别，请核对原文件]" if local_warnings else "")
    tag = _tag(node)
    if tag in ("t",):
        return node.text or ""
    if tag in ("br", "cr"):
        return "\n"
    if tag == "tab":
        return "\t"
    if tag.endswith("Pr") or tag in ("drawing", "pict", "object"):
        return ""
    return "".join(office_text(child, warnings) for child in node)


def image_relations(node):
    # 仅读取文档内部嵌入关系，不访问外部 URL/本地链接。
    return list(dict.fromkeys(blip.get("{" + R + "}embed") for blip in node.iter("{" + A + "}blip") if blip.get("{" + R + "}embed")))


def slide_shapes(shapes):
    for shape in shapes:
        if shape.shape_type == 6:  # GROUP
            yield from slide_shapes(shape.shapes)
        else:
            yield shape
