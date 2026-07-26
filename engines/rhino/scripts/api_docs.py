# -*- coding: utf-8 -*-
"""
Подсказка по API Rhino прямо из запущенного приложения.

Смысл в одной фразе: модель перестаёт УГАДЫВАТЬ сигнатуры. Вместо того чтобы
вспоминать, сколько аргументов у Brep.CreatePipe и в каком они порядке, она
спрашивает у самого Rhino — а тот отвечает по загруженным сборкам, то есть
ровно для той версии, что стоит у пользователя.

Никакой поставляемой документации: мы выполняемся внутри Rhino и пользуемся
отражением. Поэтому подсказка не устаревает вместе с версией.

Перенесено из наработок по мосту Rhino (ветка unified-server репозитория
rhino-mcp-bridge).

Примеры запроса:
  rs.AddPipe        — сигнатура и описание из rhinoscriptsyntax
  Brep.CreatePipe   — перегрузки метода RhinoCommon
"""
import inspect
import json

import System
import rhinoscriptsyntax as rs


def _clr_type(name):
    """Ищет тип .NET по короткому имени, перебирая обычные пространства имён."""
    for assembly in ("RhinoCommon", "Grasshopper"):
        for namespace in ("Rhino.Geometry.", "Rhino.", "Rhino.DocObjects.",
                          "Rhino.Display.", "Grasshopper.Kernel.", ""):
            found = System.Type.GetType("%s%s, %s" % (namespace, name, assembly))
            if found is not None:
                return found
    return None


def api_docs(query, max_overloads=14):
    q = query.strip()

    # Сначала rhinoscriptsyntax: он проще и покрывает большинство задач.
    base = q[3:] if q.startswith("rs.") else q
    fn = getattr(rs, base, None)
    if callable(fn):
        try:
            signature = base + str(inspect.signature(fn))
        except Exception:
            signature = base + "(...)"
        return {"kind": "rhinoscriptsyntax",
                "signature": signature,
                "doc": (inspect.getdoc(fn) or "")[:1800]}

    # Затем RhinoCommon: там перегрузок бывает много, поэтому список режем.
    if "." in q:
        type_name, method = q.rsplit(".", 1)
        found = _clr_type(type_name)
        if found is not None:
            overloads = []
            for m in found.GetMethods():
                if m.Name == method:
                    params = ", ".join("%s %s" % (p.ParameterType.Name, p.Name)
                                       for p in m.GetParameters())
                    overloads.append("%s %s(%s)" % (m.ReturnType.Name, m.Name, params))
            if overloads:
                return {"kind": "RhinoCommon",
                        "type": found.FullName,
                        "overloads": sorted(set(overloads))[:max_overloads]}

    return {"error": "не найдено",
            "hint": "попробуй 'rs.AddPipe', 'Brep.CreatePipe' или 'Brep.CreateFromLoft'"}


print(json.dumps(api_docs(__QUERY__), ensure_ascii=False))
