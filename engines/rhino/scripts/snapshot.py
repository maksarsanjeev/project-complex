# -*- coding: utf-8 -*-
"""
Снимок документа Rhino для веб-вьюпорта: и геометрия, и структура за один заход.

Отвечает ровно тем же, чем маршрут `/model/mesh` нашего моста SketchUp, — иначе
пришлось бы разводить два формата снимка, а вся обвязка (дерево сцены, вьюпорт,
переименование, статусбар) у них общая и про движок ничего не знает.

Где Rhino устроен иначе, и почему это не мелочь.

  СЛОЙ — КОНТЕЙНЕР. В SketchUp вложенность дают группы и компоненты, а тег
  («слой» в старых версиях) — лишь ярлык видимости, и объектов он не содержит.
  В Rhino наоборот: слои складываются в дерево через `::` и держат объекты.
  Поэтому здесь слои становятся ветками дерева, а список тегов пуст — врать о
  структуре ради единообразия нельзя.

  ГРУППЫ ПЕРЕСЕКАЮТСЯ. Объект Rhino может состоять сразу в нескольких группах,
  а у узла дерева родитель ровно один. Родителем остаётся слой, а группы
  уходят в `memberships` — их видно пометками, и дерево не ломается.

  ГЕОМЕТРИЯ НЕ ТРЕУГОЛЬНАЯ. Объекты — NURBS-поверхности, треугольников у них
  нет вовсе. Меш считается на лету и это самая дорогая часть снимка; качество
  выбрано среднее, потому что грубое врёт на скруглениях, а точное на сборке
  из полусотни деталей считается заметно дольше, чем человек готов ждать.

Всё наружу в миллиметрах. Единица документа проверена до публикации
инструментов, но масштаб всё равно применяем: документ могли переключить уже
после того, как инструменты опубликовались.
"""
import json

import Rhino
import rhinoscriptsyntax as rs
import scriptcontext as sc

rg = Rhino.Geometry

# Потолок треугольников на снимок. Больше вьюпорт в браузере не тянет плавно, а
# смысл снимка — смотреть и выделять, а не хранить модель.
# Мал против SketchUp намеренно: ответ Rhino возвращается НАПЕЧАТАННОЙ строкой,
# а не структурой, и весь меш едет текстом. Восемьдесят тысяч треугольников —
# около трёх мегабайт JSON, что через печать проходит, а двести тысяч уже нет.
# Координаты округляем до сотой миллиметра: точнее вьюпорту не нужно, а на
# длине строки это экономит вдвое.
TRIANGLE_LIMIT = 80000

EMPTY_GUID = "00000000-0000-0000-0000-000000000000"

# Округления мало: в IronPython 2 round() укорачивает ЗНАЧЕНИЕ, а печатает его
# repr со всеми семнадцатью знаками — «-0.35599999999999998» вместо «-0.356».
# На сборке это раздуло снимок до 54 мегабайт. Подменяем печать чисел, а
# хвостовые нули срезаем: «700.0» это те же четыре лишних знака на каждую
# координату.
def _short_float(value):
    text = "%.3f" % value
    text = text.rstrip("0").rstrip(".")
    return text if text not in ("", "-") else "0"


json.encoder.FLOAT_REPR = _short_float

# Вставка блока называется по-разному в разных версиях RhinoCommon, и обращение
# к несуществующему имени роняет весь снимок целиком. Поэтому тип ищем, а не
# называем: нет его — значит блоков в этой версии просто не распознаем.
BLOCK_TYPE = getattr(rg, "InstanceReferenceGeometry", None) or getattr(rg, "InstanceReference", None)


def _is_block(geometry):
    return BLOCK_TYPE is not None and isinstance(geometry, BLOCK_TYPE)


def _mm_scale():
    """Во сколько раз единица документа больше миллиметра."""
    return Rhino.RhinoMath.UnitScale(sc.doc.ModelUnitSystem, Rhino.UnitSystem.Millimeters)


def _layer_tree():
    """Слои деревом: узел на слой, родитель — по полной цепочке имени."""
    nodes = []
    by_id = {}

    for layer in sc.doc.Layers:
        if layer.IsDeleted:
            continue
        node_id = "layer:%s" % layer.FullPath
        by_id[layer.Id] = node_id
        parent = None
        # Корневой слой узнаём по пустому GUID родителя. Именованной константы
        # для этого нет: Layer.RootId существует не во всех версиях Rhino, и на
        # 8.x запрос снимка падал именно здесь.
        if str(layer.ParentLayerId) != EMPTY_GUID:
            parent_layer = sc.doc.Layers.FindId(layer.ParentLayerId)
            if parent_layer:
                parent = "layer:%s" % parent_layer.FullPath
        nodes.append({
            "id": node_id,
            "name": layer.Name,
            "kind": "layer",
            "parentId": parent,
            "visible": layer.IsVisible,
            "locked": layer.IsLocked,
        })

    return nodes, by_id


def _groups_of(obj):
    """Имена групп, в которых состоит объект."""
    names = []
    indexes = obj.Attributes.GetGroupList()
    if not indexes:
        return names
    for index in indexes:
        group = sc.doc.Groups.FindIndex(index)
        if group:
            names.append(group.Name or ("группа %d" % index))
    return names


def _mesh_of(geometry):
    """Треугольники объекта. Возвращает (позиции, нормали, число)."""
    meshes = []

    if isinstance(geometry, rg.Mesh):
        meshes = [geometry]
    elif isinstance(geometry, (rg.Brep, rg.Extrusion)):
        brep = geometry.ToBrep() if isinstance(geometry, rg.Extrusion) else geometry
        # Грубая сетка, а не «по умолчанию». Снимок нужен, чтобы СМОТРЕТЬ и
        # выделять, а не чтобы по нему работать: точная сетка на этой же сборке
        # дала 20 мегабайт текста, грубая — впятеро меньше при неотличимом на
        # глаз силуэте. Считать по снимку нечего, для этого есть rh_inspect.
        parameters = getattr(rg.MeshingParameters, "Coarse", None) or rg.MeshingParameters.Default
        made = rg.Mesh.CreateFromBrep(brep, parameters)
        meshes = list(made) if made else []
    elif isinstance(geometry, rg.SubD):
        made = rg.Mesh.CreateFromSubD(geometry, 2)
        if made:
            meshes = [made]

    positions = []
    normals = []
    count = 0
    scale = _mm_scale()

    for mesh in meshes:
        if mesh is None:
            continue
        # Нормали нужны вьюпорту для затенения; у сетки из Brep их может не
        # быть, если поверхность вырожденная.
        mesh.Normals.ComputeNormals()
        vertices = mesh.Vertices
        vnormals = mesh.Normals

        for face in mesh.Faces:
            # Квад — это два треугольника. Вьюпорт принимает только их.
            triples = [(face.A, face.B, face.C)]
            if face.IsQuad:
                triples.append((face.A, face.C, face.D))

            for triple in triples:
                for index in triple:
                    point = vertices[index]
                    positions.extend([round(point.X * scale, 2),
                                      round(point.Y * scale, 2),
                                      round(point.Z * scale, 2)])
                    if index < vnormals.Count:
                        normal = vnormals[index]
                        normals.extend([round(normal.X, 3),
                                        round(normal.Y, 3),
                                        round(normal.Z, 3)])
                    else:
                        normals.extend([0.0, 0.0, 1.0])
                count += 1

    return positions, normals, count


def _materials():
    out = []
    for material in sc.doc.Materials:
        if material.IsDeleted:
            continue
        colour = material.DiffuseColor
        out.append({
            "name": material.Name or "(без имени)",
            "color": {"r": colour.R, "g": colour.G, "b": colour.B},
            "alpha": round(1.0 - material.Transparency, 3),
            "textured": material.GetTextures().Length > 0 if hasattr(material, "GetTextures") else False,
            "used": 0,
        })
    return out


def _definitions():
    out = []
    for definition in sc.doc.InstanceDefinitions:
        if definition.IsDeleted:
            continue
        out.append({
            "name": definition.Name,
            # Блок Rhino — всегда ссылка: правка определения меняет все вставки.
            # Независимых копий, как у групп SketchUp, здесь не бывает.
            "group": False,
            "instances": len(definition.GetReferences(0)),
            "entities": len(definition.GetObjects()),
        })
    return out


def snapshot():
    nodes, layer_nodes = _layer_tree()
    parts = []
    selection = []
    total = 0
    truncated = False

    material_use = {}

    for obj in sc.doc.Objects:
        if obj.IsDeleted:
            continue

        geometry = obj.Geometry
        node_id = "ent:%s" % obj.Id
        layer = sc.doc.Layers.FindIndex(obj.Attributes.LayerIndex)
        parent = layer_nodes.get(layer.Id) if layer else None

        material_name = None
        if obj.Attributes.MaterialIndex >= 0:
            material = sc.doc.Materials.FindIndex(obj.Attributes.MaterialIndex)
            if material:
                material_name = material.Name or None
                if material_name:
                    material_use[material_name] = material_use.get(material_name, 0) + 1

        groups = _groups_of(obj)

        node = {
            "id": node_id,
            "name": obj.Name or _kind_of(geometry).capitalize(),
            "kind": _kind_of(geometry),
            "parentId": parent,
            "visible": obj.Attributes.Visible,
            "locked": obj.IsLocked,
        }
        if material_name:
            node["material"] = material_name
        if layer:
            node["tag"] = layer.FullPath
        if groups:
            node["memberships"] = groups
        if _is_block(geometry):
            definition = sc.doc.InstanceDefinitions.FindId(geometry.ParentIdefId)
            if definition:
                node["definition"] = definition.Name
                node["instances"] = len(definition.GetReferences(0))

        if obj.IsSelected(False):
            selection.append(node_id)

        if total < TRIANGLE_LIMIT:
            positions, normals, count = _mesh_of(geometry)
            if count:
                total += count
                # Потолок проверяется ДО объекта, поэтому последний способен
                # его перешагнуть. Отмечаем это сразу: иначе снимок молча
                # выходит вдвое больше обещанного.
                if total >= TRIANGLE_LIMIT:
                    truncated = True
                node["triangles"] = count
                parts.append({
                    "nodeId": node_id,
                    "layer": layer.FullPath if layer else "",
                    "triangles": count,
                    "positions": positions,
                    "normals": normals,
                })
        else:
            truncated = True

        nodes.append(node)

    materials = _materials()
    for material in materials:
        material["used"] = material_use.get(material["name"], 0)

    return {
        "title": sc.doc.Name or "Без имени",
        "units": "mm",
        "triangles": total,
        "truncated": truncated,
        "nodes": nodes,
        "parts": parts,
        # Слой в Rhino — контейнер, а не ярлык, и он уже стал веткой дерева.
        # Дублировать его ещё и тегом значило бы показать одно и то же дважды.
        "tags": [],
        "materials": materials,
        "definitions": _definitions(),
        "selection": selection,
    }


def _kind_of(geometry):
    if _is_block(geometry):
        return "block"
    if isinstance(geometry, rg.Mesh):
        return "mesh"
    if isinstance(geometry, (rg.Curve, rg.LineCurve, rg.PolyCurve)):
        return "curve"
    if isinstance(geometry, (rg.Brep, rg.Extrusion, rg.SubD)):
        # Замкнутое тело и открытая поверхность ведут себя по-разному при
        # булевых операциях, и в дереве это стоит различать сразу.
        brep = geometry.ToBrep() if isinstance(geometry, rg.Extrusion) else geometry
        if isinstance(brep, rg.Brep) and brep.IsSolid:
            return "solid"
        return "surface"
    return "mesh"


# ensure_ascii оставлен ПО УМОЛЧАНИЮ, то есть включён, и это не небрежность.
# Ответ Rhino приходит напечатанной строкой через несколько слоёв перекодировки,
# и кириллица в ней превращается в мусор — видно на именах слоёв. Экранирование
# делает строку целиком из ASCII, которому эти слои уже не вредят.
#
# Метки вокруг документа — не украшение. Плагин отдаёт напечатанное ДВАЖДЫ:
# на этой сборке 10,5 мегабайта превратились в 21, и разбор падал на «лишних
# символах после JSON». Причина в чужом коде, чинить её нам нечем, а вот брать
# первый экземпляр по меткам — надёжно и не зависит от того, починят ли её.
print("<<<COMPLEX-SNAPSHOT")
print(json.dumps(snapshot()))
print("COMPLEX-SNAPSHOT>>>")
