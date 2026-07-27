# -*- coding: utf-8 -*-
"""
Разбор сборки одним ответом: габариты, положение, стыки, замкнутость.

Зачем отдельно от discipline.py: тот отвечает на вопрос «можно ли сдавать»,
а этот — на вопрос «где что стоит и как соприкасается». На шуруповёрте модель
задала его четырьмя отдельными скриптами подряд — угол рукояти, зазор до
курка, объём пересечения, замкнутость тел, — и каждый скрипт стоил круга.

Один ответ вместо четырёх экономит не только деньги, но и внимание: всё видно
рядом, и несуразица бросается в глаза сразу.

Все длины в миллиметрах — единицы документа проверены до публикации инструментов.
"""
import json

import Rhino
import rhinoscriptsyntax as rs

rg = Rhino.Geometry


def _objects(ids=None, layer=None):
    if ids:
        return ids if isinstance(ids, list) else [ids]
    if layer:
        return rs.ObjectsByLayer(layer) or []
    return rs.AllObjects() or []


def _round3(p):
    return [round(p.X, 1), round(p.Y, 1), round(p.Z, 1)]


def inspect(ids=None, layer=None, contacts=True):
    objs = _objects(ids, layer)
    report = {"objects": [], "units": rs.UnitSystemName(False, False, True)}

    whole = rg.BoundingBox.Empty
    geoms = []

    for o in objs:
        g = rs.coercegeometry(o)
        if g is None:
            continue
        bb = g.GetBoundingBox(True)
        whole.Union(bb)
        geoms.append((o, g, bb))

        item = {
            "id": str(o),
            "name": rs.ObjectName(o) or "(без имени)",
            "layer": rs.ObjectLayer(o),
            "type": g.GetType().Name,
            "min": _round3(bb.Min),
            "max": _round3(bb.Max),
            "size": [round(bb.Max.X - bb.Min.X, 1),
                     round(bb.Max.Y - bb.Min.Y, 1),
                     round(bb.Max.Z - bb.Min.Z, 1)],
        }
        if isinstance(g, rg.Brep):
            item["closed"] = g.IsSolid
            if g.IsSolid:
                item["volume"] = round(rg.VolumeMassProperties.Compute(g).Volume, 1)
        report["objects"].append(item)

    if whole.IsValid:
        report["bbox"] = {
            "min": _round3(whole.Min),
            "max": _round3(whole.Max),
            "size": [round(whole.Max.X - whole.Min.X, 1),
                     round(whole.Max.Y - whole.Min.Y, 1),
                     round(whole.Max.Z - whole.Min.Z, 1)],
        }

    # Стыки: объём пересечения пары тел. Ноль при соприкосновении габаритов —
    # значит детали рядом, но не соединены; именно так «курок висел в воздухе»
    # при том, что габариты перекрывались.
    if contacts:
        pairs = []
        for i in range(len(geoms)):
            for j in range(i + 1, len(geoms)):
                (oi, gi, bi), (oj, gj, bj) = geoms[i], geoms[j]
                if not isinstance(gi, rg.Brep) or not isinstance(gj, rg.Brep):
                    continue
                overlap = rg.BoundingBox.Intersection(bi, bj)
                if not (overlap.IsValid and overlap.Volume > 0.001):
                    continue
                shared = 0.0
                try:
                    parts = rg.Brep.CreateBooleanIntersection(
                        [gi], [gj], rs.UnitAbsoluteTolerance())
                    if parts:
                        shared = sum(rg.VolumeMassProperties.Compute(b).Volume for b in parts)
                except Exception:
                    pass
                pairs.append({
                    "a": rs.ObjectName(oi) or str(oi),
                    "b": rs.ObjectName(oj) or str(oj),
                    "shared_volume": round(shared, 1),
                    # Габариты перекрываются, а тела нет — деталь рядом, но не
                    # прилегает. Самая частая ошибка сборки, и самая незаметная.
                    "touching": shared > 0.001,
                })
        report["contacts"] = pairs

    return report


print(json.dumps(inspect(ids=__IDS__, layer=__LAYER__, contacts=__CONTACTS__),
                 ensure_ascii=False))
