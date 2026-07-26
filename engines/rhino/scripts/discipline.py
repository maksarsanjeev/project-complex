# -*- coding: utf-8 -*-
"""
Проверка дисциплины модели перед тем, как объявить работу законченной.

Отвечает на вопросы, которые иначе задаёт себе человек, открывая файл: сколько
объектов получилось, все ли тела замкнуты, не проникают ли детали друг в друга,
и какие вышли габариты и пропорции.

Перенесено из наработок по мосту Rhino (ветка unified-server репозитория
rhino-mcp-bridge). Транспорт с тех пор сменился на сторонний плагин, а смысл
проверок остался: разбор на части, замкнутость, коллизии, пропорции.

Скрипт самодостаточен: отправляется в Rhino целиком и печатает JSON. Ничего
устанавливать и подгружать заранее не нужно — состояния между вызовами нет.

ЕДИНИЦЫ. Все длины — в единицах документа. Инструменты Rhino публикуются
только когда документ в миллиметрах, так что габариты в отчёте — миллиметры.
"""
import json

import Rhino
import rhinoscriptsyntax as rs

rg = Rhino.Geometry


def _resolve(ids=None, layer=None):
    if ids:
        return ids if isinstance(ids, list) else [ids]
    if layer:
        return rs.ObjectsByLayer(layer) or []
    return rs.AllObjects() or []


def check_solids(objs):
    """Замкнутость тел. Открытая оболочка не станет ни литым телом, ни печатью."""
    res = {"checked": 0, "solid": 0, "open": 0, "invalid": 0,
           "open_ids": [], "invalid_ids": []}
    for o in objs:
        g = rs.coercegeometry(o)
        if isinstance(g, rg.Brep):
            res["checked"] += 1
            if not g.IsValid:
                res["invalid"] += 1
                res["invalid_ids"].append(str(o))
            elif g.IsSolid:
                res["solid"] += 1
            else:
                res["open"] += 1
                res["open_ids"].append(str(o))
    return res


def check_collisions(objs, tol=0.01):
    """
    Ищет взаимно проникающие тела: детали должны соприкасаться, а не пересекаться.

    Сначала дешёвая проверка пересечения габаритных коробок, и только для
    прошедших её пар — настоящее пересечение поверхностей. Без такого отсева
    задача становится квадратичной по числу тел, а не по числу подозрительных пар.
    """
    breps = [(o, rs.coercegeometry(o)) for o in objs]
    breps = [(o, g) for o, g in breps if isinstance(g, rg.Brep)]
    hits, pairs = [], 0
    for i in range(len(breps)):
        for j in range(i + 1, len(breps)):
            oi, gi = breps[i]
            oj, gj = breps[j]
            inter = rg.BoundingBox.Intersection(gi.GetBoundingBox(True),
                                                gj.GetBoundingBox(True))
            if not (inter.IsValid and inter.Volume > tol):
                continue
            pairs += 1
            res = rg.Intersect.Intersection.BrepBrep(gi, gj, tol)
            crvs = res[1] if res and len(res) > 1 else None
            if crvs and len(crvs) > 0:
                hits.append({"a": str(oi), "b": str(oj), "curves": len(crvs)})
    return {"breps": len(breps), "bbox_overlaps": pairs,
            "collisions": len(hits), "hits": hits}


def discipline_report(layer=None, ids=None, anchor=None):
    objs = _resolve(ids, layer)
    report = {
        "objects": len(objs),
        "solids": check_solids(objs),
        "collisions": check_collisions(objs),
        "units": rs.UnitSystemName(False, False, True),
    }

    bb = rg.BoundingBox.Empty
    for o in objs:
        g = rs.coercegeometry(o)
        if g:
            bb.Union(g.GetBoundingBox(True))

    if bb.IsValid:
        dx = bb.Max.X - bb.Min.X
        dy = bb.Max.Y - bb.Min.Y
        dz = bb.Max.Z - bb.Min.Z
        report["dims"] = [round(dx, 2), round(dy, 2), round(dz, 2)]
        smallest = min([d for d in (dx, dy, dz) if d > 0] or [1.0])
        report["proportions"] = [round(dx / smallest, 2),
                                 round(dy / smallest, 2),
                                 round(dz / smallest, 2)]
        # Опорный размер: во сколько раз модель разошлась с известной величиной.
        # Так ловится ошибка масштаба, которую по одним пропорциям не видно.
        if anchor:
            biggest = max(dx, dy, dz)
            report["scale_to_anchor"] = round(float(anchor) / biggest, 5) if biggest else None

    warnings = []
    if report["collisions"]["collisions"]:
        warnings.append("%d пересечений тел" % report["collisions"]["collisions"])
    if report["solids"]["open"]:
        warnings.append("%d незамкнутых оболочек" % report["solids"]["open"])
    if report["solids"]["invalid"]:
        warnings.append("%d повреждённых тел" % report["solids"]["invalid"])
    report["verdict"] = "в порядке" if not warnings else "внимание: " + "; ".join(warnings)

    return report


print(json.dumps(discipline_report(layer=__LAYER__, ids=__IDS__, anchor=__ANCHOR__),
                 ensure_ascii=False))
