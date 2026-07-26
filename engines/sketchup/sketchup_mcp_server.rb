# sketchup_mcp_server.rb
# SketchUp MCP Bridge Plugin - v2.3
#
# Embeds a lightweight TCP/HTTP server inside SketchUp so that
# an external MCP server (Python) can drive SketchUp programmatically.
#
# Installation: Copy ONLY this single file into your SketchUp Plugins directory.
#   Windows: %APPDATA%\SketchUp\SketchUp <version>\SketchUp\Plugins\
#   macOS:   ~/Library/Application Support/SketchUp <version>/SketchUp/Plugins/
#
# After copying, restart SketchUp.
#
# --- v2.1: несколько окон SketchUp одновременно -----------------------------
# На Windows каждая модель — отдельный процесс SketchUp со своим Ruby, и плагин
# грузится в каждый. Раньше все они дрались за один порт 8080: занимал первый
# запущенный, остальные показывали модальное окно и переставали существовать
# для внешнего мира. Теперь:
#
#   * порт 8080 берётся, только если свободен; иначе ОС выдаёт любой свободный;
#   * слушаем 127.0.0.1, а не 0.0.0.0 — мост исполняет произвольный Ruby и не
#     должен торчать в сеть; наружу смотрит агент, у которого есть токен;
#   * каждый экземпляр пишет «визитку» в INSTANCES_DIR: uuid, pid, порт и какая
#     модель открыта. По ней внешняя сторона видит ВСЕ окна и адресует нужное;
#   * при старте визитки мёртвых процессов подчищаются;
#   * никаких модальных окон при запуске: диалог останавливает главный поток
#     SketchUp, а на нём же работает обработчик очереди — мост немел целиком.
#
# --- v2.2 -------------------------------------------------------------------
#   * булевы операции, фаски и скругления рёбер — алгоритмы перенесены из
#     zinin/sketchup-mcp2 вместе с описанием обойдённых ловушек.
#     Copyright (c) 2026 Alexander Zinin <mail@zinin.ru>, лицензия MIT,
#     полный текст уведомления — в файле LICENSE в корне репозитория;
#   * живость экземпляра определяется по возрасту визитки, а не по PID:
#     на Windows Process.kill(0, pid) рапортует «жив» для мёртвых процессов;
#   * визитка убирается и при обычном закрытии SketchUp, а не только из меню.
#
# --- v2.3 -------------------------------------------------------------------
#   * пункт меню «Окно для ИИ / Window for AI»: человек сам отмечает окно, в
#     котором работает ИИ. Раньше при нескольких открытых окнах вызов падал с
#     просьбой назвать окно — защита от постройки в чужом проекте была, а
#     удобства не было.
#
#     Угадывать по окну переднего плана нельзя: пока человек пишет задание в
#     браузере, впереди браузер, и признак не находит ни одного окна ровно
#     тогда, когда он нужен.
#
#     Окна не договариваются между собой — на Windows это разные процессы, и
#     общая у них только папка визиток. Поэтому окно не «забирает» признак у
#     других, а лишь отмечает время нажатия; побеждает самое свежее, и решает
#     это читающая сторона.

require 'socket'
require 'json'
require 'sketchup'
require 'uri'
require 'stringio'
require 'base64'
require 'fileutils'

module SU_MCP
  # Предпочитаемый порт. Занят — возьмём любой свободный у системы.
  PREFERRED_PORT = 8080
  PORT = PREFERRED_PORT # совместимость со старым кодом, который читал константу

  # Куда экземпляры кладут визитки о себе.
  # Слэши приводим к прямым: Dir.glob на Windows считает обратный слэш
  # экранирующим символом, а LOCALAPPDATA приходит именно с ними.
  INSTANCES_DIR = File.join(
    ENV['LOCALAPPDATA'] || File.join(Dir.home, '.local', 'share'),
    'complex', 'instances'
  ).tr('\\', '/')

  # Constants
  ORIGIN = Geom::Point3d.new(0, 0, 0)
  X_AXIS = Geom::Vector3d.new(1, 0, 0)
  Y_AXIS = Geom::Vector3d.new(0, 1, 0)
  Z_AXIS = Geom::Vector3d.new(0, 0, 1)

  # Thread-safe request queue
  @request_queue = []
  @queue_mutex = Mutex.new
  @timer_id = nil
  @server = nil
  @thread = nil
  @running = false

  # Фактический порт: известен только после привязки.
  @port = nil
  # Счётчик тиков таймера — по нему освежаем визитку, не чаще раза в 2 секунды.
  @ticks = 0

  # Идентификатор экземпляра. Живёт до перезапуска SketchUp и уникален везде,
  # в отличие от PID, который переиспользуется системой.
  @instance_id = begin
    require 'securerandom'
    SecureRandom.uuid
  rescue StandardError, LoadError
    # Запасной путь, если securerandom недоступен.
    "%08x-%04x-%04x-%012x" % [rand(2**32), rand(2**16), rand(2**16), rand(2**48)]
  end

  def self.instance_id
    @instance_id
  end

  def self.port
    @port
  end

  # Log file in temp directory (cross-platform)
  LOG_DIR = File.join(ENV['TEMP'] || ENV['TMPDIR'] || '/tmp')
  # Файл на процесс. Общий лог не годится: окон SketchUp много, все пишут
  # одновременно, строки перемешиваются и часть теряется — проверено на трёх.
  LOG_FILE = File.join(LOG_DIR, "sketchup_mcp_#{Process.pid}.log")

  def self.log(msg)
    ts = Time.now.strftime("%H:%M:%S.%L")
    line = "[MCP #{ts} pid #{Process.pid}] #{msg}"
    puts line
    begin
      File.open(LOG_FILE, 'a') { |f| f.puts(line); f.flush }
    rescue
      # silently ignore log write failures
    end
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  def self.model
    Sketchup.active_model
  end

  def self.entities
    model.active_entities
  end

  # ---------------------------------------------------------------------------
  # Единицы: НАРУЖУ всегда миллиметры
  #
  # Внутри SketchUp длины считаются в дюймах — это не настраивается. Поэтому
  # переводим ровно на границе: всё, что пришло от клиента, сразу в дюймы,
  # всё, что уходит клиенту, — обратно в миллиметры. Внутри обработчиков
  # дюймы, снаружи миллиметры, смешения нет нигде.
  #
  # НЕ конвертируются: направления и нормали (единичные векторы), углы,
  # коэффициенты масштабирования, количества — они безразмерны.
  # ---------------------------------------------------------------------------

  MM_PER_INCH = 25.4

  # мм → внутренние дюймы
  def self.mm(value)
    value.to_f / MM_PER_INCH
  end

  # внутренние дюймы → мм
  def self.to_mm(value)
    (value.to_f * MM_PER_INCH).round(3)
  end

  # площадь: квадратные дюймы → квадратные миллиметры
  def self.area_mm(value)
    (value.to_f * MM_PER_INCH * MM_PER_INCH).round(2)
  end

  def self.parse_point(arr)
    Geom::Point3d.new(mm(arr[0]), mm(arr[1]), mm(arr[2]))
  end

  def self.parse_points(arr)
    arr.map { |p| parse_point(p) }
  end

  # Безразмерный вектор: направления и нормали отдаём как есть.
  def self.vec3(v)
    [v.x.to_f, v.y.to_f, v.z.to_f]
  end

  # Точка в пространстве: наружу уходит в миллиметрах.
  def self.pt_mm(p)
    [to_mm(p.x), to_mm(p.y), to_mm(p.z)]
  end

  def self.find_group(name)
    model.entities.grep(Sketchup::Group).find { |g| g.name == name }
  end

  def self.find_entity_by_id(id_val)
    id = id_val.to_i
    # Search everywhere: top-level entities, inside groups, inside components
    search_entities(model.entities, id)
  end

  def self.search_entities(ents, id)
    ents.each do |e|
      return e if e.entityID == id
      if e.is_a?(Sketchup::Group)
        found = search_entities(e.entities, id)
        return found if found
      elsif e.is_a?(Sketchup::ComponentInstance)
        found = search_entities(e.definition.entities, id)
        return found if found
      end
    end
    nil
  end

  def self.apply_layer(entity, name)
    return unless name && !name.empty?
    layer = model.layers[name] || model.layers.add(name)
    entity.layer = layer
  end

  def self.apply_material(entity, name)
    return unless name && !name.empty?
    mat = model.materials[name] || model.materials.add(name)
    entity.material = mat if entity.respond_to?(:material=)
  end

  # ---------------------------------------------------------------------------
  # Визитка экземпляра
  #
  # Внешняя сторона не может угадать, в каком из открытых окон нужная модель:
  # порты теперь произвольные, а PID ничего не говорит о содержимом. Поэтому
  # каждый экземпляр сам сообщает о себе файлом.
  # ---------------------------------------------------------------------------

  def self.model_descriptor
    m = model
    {
      model_title: (m.title.to_s.empty? ? 'Untitled' : m.title),
      model_path:  (m.path.to_s.empty? ? nil : m.path),
      # guid переживает переименование файла, поэтому надёжнее пути
      model_guid:  (m.guid rescue nil)
    }
  rescue StandardError
    { model_title: nil, model_path: nil, model_guid: nil }
  end

  # ---------------------------------------------------------------------------
  # Окно для ИИ
  #
  # Когда открыто несколько окон, внешняя сторона не может решить, в каком из
  # них работать. Угадывать нельзя: построить стену в чужом проекте — дорогая
  # ошибка. Поэтому выбор делает человек кнопкой, а не мы за него.
  #
  # Договориться между окнами не получится: каждое окно SketchUp — отдельный
  # процесс, общая у них только папка визиток. Поэтому окно не «забирает»
  # признак у других, а лишь отмечает время нажатия. Побеждает самое свежее —
  # эту проверку делает читающая сторона. Никакой межпроцессной связи не нужно.
  # ---------------------------------------------------------------------------

  @ai_target_at = nil

  def self.ai_target?
    !@ai_target_at.nil?
  end

  def self.toggle_ai_target
    @ai_target_at = ai_target? ? nil : Time.now.utc
    write_card # не ждём очередного тика: человек нажал и ждёт ответа сейчас
    if ai_target?
      Sketchup.status_text = "Это окно выбрано для ИИ: #{model_descriptor[:model_title]}"
    else
      Sketchup.status_text = 'Окно снято с работы ИИ'
    end
    ai_target?
  end

  def self.instance_descriptor
    {
      instance_id: @instance_id,
      pid:         Process.pid,
      port:        @port,
      host:        '127.0.0.1',
      app:         'sketchup',
      app_version: (Sketchup.version.to_s rescue nil),
      plugin:      '2.3',
      # Когда человек назначил это окно рабочим для ИИ. nil — не назначал.
      ai_target_at: (@ai_target_at ? @ai_target_at.strftime('%Y-%m-%dT%H:%M:%SZ') : nil)
    }.merge(model_descriptor)
  end

  def self.card_path
    File.join(INSTANCES_DIR, "sketchup-#{Process.pid}.json")
  end

  def self.write_card
    FileUtils.mkdir_p(INSTANCES_DIR)
    data = instance_descriptor.merge(updated_at: Time.now.utc.strftime('%Y-%m-%dT%H:%M:%SZ'))
    File.open(card_path, 'w') { |f| f.write(JSON.pretty_generate(data)) }
  rescue StandardError => e
    log "Card write failed: #{e.message}"
  end

  def self.remove_card
    File.delete(card_path) if File.exist?(card_path)
  rescue StandardError => e
    log "Card remove failed: #{e.message}"
  end

  # Живость определяем по возрасту визитки, а НЕ по PID.
  #
  # Замерено на Windows: Process.kill(0, pid) рапортует «жив» для давно умерших
  # процессов, поэтому проверка по сигналу здесь бесполезна — мёртвые визитки
  # копились бы вечно. Возраст же работает на любой платформе: живой экземпляр
  # переписывает свою визитку каждые 2 секунды.
  #
  # Ложное срабатывание безвредно: если окно всего лишь подвисло на модальном
  # диалоге, оно перепишет визитку на следующем тике и та появится снова.
  CARD_STALE_AFTER = 30 # секунд

  def self.card_stale?(path)
    data = JSON.parse(File.read(path))
    stamp = data['updated_at']
    return true unless stamp
    (Time.now.utc - parse_iso_utc(stamp)) > CARD_STALE_AFTER
  rescue StandardError
    # Битую или нечитаемую визитку считаем мусором.
    true
  end

  # Разбор метки вида 2026-07-26T02:41:05Z без подключения лишних библиотек.
  def self.parse_iso_utc(text)
    m = text.to_s.match(/\A(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z\z/)
    raise ArgumentError, "bad timestamp: #{text}" unless m
    Time.utc(m[1].to_i, m[2].to_i, m[3].to_i, m[4].to_i, m[5].to_i, m[6].to_i)
  end

  def self.sweep_stale_cards
    return unless File.directory?(INSTANCES_DIR)
    Dir.glob(File.join(INSTANCES_DIR, 'sketchup-*.json')).each do |path|
      next if File.basename(path) == File.basename(card_path)
      next unless card_stale?(path)
      File.delete(path) rescue nil
      log "Swept stale card #{File.basename(path)}"
    end
  rescue StandardError => e
    log "Sweep failed: #{e.message}"
  end

  # ---------------------------------------------------------------------------
  # Handlers — each returns a Ruby hash (will be JSON-encoded)
  # ---------------------------------------------------------------------------

  # --- Query ---

  def self.handle_get_model_info(_p)
    m = model
    {
      name:           m.title,
      description:    m.description,
      path:           m.path,
      modified:       m.modified?,
      unit:           m.options['UnitsOptions']['LengthUnit'],
      entity_count:   m.entities.count,
      layer_count:    m.layers.count,
      material_count: m.materials.count
    }
  end

  def self.handle_list_layers(_p)
    model.layers.map { |l| { name: l.name, visible: l.visible? } }
  end

  def self.handle_list_materials(_p)
    model.materials.map do |mat|
      c = mat.color
      {
        name:    mat.name,
        color:   { r: c.red, g: c.green, b: c.blue, a: c.alpha },
        texture: mat.texture ? mat.texture.filename : nil
      }
    end
  end

  def self.handle_list_entities(p)
    ents = if p['group_name']
             g = find_group(p['group_name'])
             raise "Group '#{p['group_name']}' not found" unless g
             g.entities
           else
             model.entities
           end

    ents.map do |e|
      base = { id: e.entityID, type: e.class.name.split('::').last }
      case e
      when Sketchup::Group
        base[:name]  = e.name
        base[:layer] = e.layer.name
      when Sketchup::ComponentInstance
        base[:name]  = e.definition.name
        base[:layer] = e.layer.name
      when Sketchup::Face
        base[:area]   = area_mm(e.area)
        base[:layer]  = e.layer.name
        base[:normal] = vec3(e.normal)
      when Sketchup::Edge
        base[:length] = to_mm(e.length)
        base[:layer]  = e.layer.name
      end
      base
    end
  end

  def self.handle_list_components(_p)
    model.definitions.reject(&:image?).map do |d|
      {
        name:           d.name,
        description:    d.description,
        instances:      d.instances.count,
        entity_count:   d.entities.count
      }
    end
  end

  # --- Create geometry ---

  def self.handle_create_face(p)
    pts = parse_points(p['points'])
    raise "Need >= 3 points" if pts.length < 3
    model.start_operation('MCP: Face', true)
    face = entities.add_face(pts)
    apply_layer(face, p['layer'])
    apply_material(face, p['material'])
    model.commit_operation
    { id: face.entityID, type: 'Face', area: area_mm(face.area), normal: vec3(face.normal) }
  end

  def self.handle_create_edge(p)
    s = parse_point(p['start'])
    e = parse_point(p['end'])
    model.start_operation('MCP: Edge', true)
    edge = entities.add_line(s, e)
    apply_layer(edge, p['layer'])
    model.commit_operation
    { id: edge.entityID, type: 'Edge', length: to_mm(edge.length) }
  end

  def self.handle_create_group(p)
    model.start_operation('MCP: Group', true)
    group = entities.add_group
    group.name = p['name'] || ''
    apply_layer(group, p['layer'])
    model.commit_operation
    { id: group.entityID, name: group.name }
  end

  def self.handle_create_box(p)
    # Наружу габариты в миллиметрах, внутрь — в дюймах.
    w_mm = p['width'].to_f
    d_mm = p['depth'].to_f
    h_mm = p['height'].to_f
    w = mm(w_mm)
    d = mm(d_mm)
    h = mm(h_mm)
    o = p['origin'] ? parse_point(p['origin']) : ORIGIN

    model.start_operation('MCP: Box', true)
    grp = entities.add_group
    ge = grp.entities
    pts = [
      o,
      Geom::Point3d.new(o.x + w, o.y,     o.z),
      Geom::Point3d.new(o.x + w, o.y + d, o.z),
      Geom::Point3d.new(o.x,     o.y + d, o.z)
    ]
    face = ge.add_face(pts)
    face.pushpull(-h)  # pushpull into +Z
    apply_layer(grp, p['layer'])
    apply_material(face, p['material']) if p['material']
    grp.name = p['name'] || "Box_#{w_mm.round}x#{d_mm.round}x#{h_mm.round}"
    model.commit_operation
    { id: grp.entityID, name: grp.name, width: w_mm, depth: d_mm, height: h_mm, units: 'mm' }
  end

  def self.handle_create_circle(p)
    center   = p['center']   ? parse_point(p['center'])   : ORIGIN
    normal   = p['normal']   ? Geom::Vector3d.new(*p['normal'].map(&:to_f)) : Z_AXIS
    radius_mm = p['radius'].to_f
    segments  = (p['segments'] || 24).to_i
    raise "Radius must be positive" if radius_mm <= 0
    raise "Segments must be >= 3"   if segments < 3

    model.start_operation('MCP: Circle', true)
    edges = entities.add_circle(center, normal, mm(radius_mm), segments)
    if p['layer']
      edges.each { |e| apply_layer(e, p['layer']) }
    end
    model.commit_operation
    { edge_count: edges.length, center: pt_mm(center), radius: radius_mm,
      segments: segments, units: 'mm' }
  end

  def self.handle_create_arc(p)
    center     = p['center'] ? parse_point(p['center']) : ORIGIN
    xaxis      = p['xaxis']  ? Geom::Vector3d.new(*p['xaxis'].map(&:to_f))  : X_AXIS
    normal     = p['normal'] ? Geom::Vector3d.new(*p['normal'].map(&:to_f)) : Z_AXIS
    radius_mm  = p['radius'].to_f
    start_a    = (p['start_angle'] || 0).to_f
    end_a      = (p['end_angle']   || 180).to_f
    segments   = (p['segments']    || 12).to_i
    raise "Radius must be positive" if radius_mm <= 0

    model.start_operation('MCP: Arc', true)
    edges = entities.add_arc(center, xaxis, normal, mm(radius_mm),
                             start_a.degrees, end_a.degrees, segments)
    if p['layer']
      edges.each { |e| apply_layer(e, p['layer']) }
    end
    model.commit_operation
    { edge_count: edges.length, center: pt_mm(center), radius: radius_mm, units: 'mm' }
  end

  def self.handle_create_polygon(p)
    center    = p['center'] ? parse_point(p['center']) : ORIGIN
    normal    = p['normal'] ? Geom::Vector3d.new(*p['normal'].map(&:to_f)) : Z_AXIS
    radius_mm = p['radius'].to_f
    num_sides = p['num_sides'].to_i
    inscribed = p['inscribed'].nil? ? true : p['inscribed']
    raise "Radius must be positive"     if radius_mm <= 0
    raise "Need at least 3 sides"       if num_sides < 3

    model.start_operation('MCP: Polygon', true)
    edges = entities.add_ngon(center, normal, mm(radius_mm), num_sides, inscribed)
    # Also create the face
    pts = edges.map { |e| e.start.position }
    face = entities.add_face(pts) rescue nil
    apply_layer(face, p['layer']) if face && p['layer']
    apply_material(face, p['material']) if face && p['material']
    model.commit_operation
    {
      edge_count: edges.length,
      face_id:    face ? face.entityID : nil,
      center:     pt_mm(center),
      radius:     radius_mm,
      num_sides:  num_sides,
      units:      'mm'
    }
  end

  def self.handle_push_pull(p)
    eid     = p['entity_id']
    dist_mm = p['distance'].to_f
    raise "entity_id required" unless eid

    face = find_entity_by_id(eid)
    raise "Entity #{eid} not found"        unless face
    raise "Entity #{eid} is not a Face"    unless face.is_a?(Sketchup::Face)

    model.start_operation('MCP: PushPull', true)
    face.pushpull(mm(dist_mm))
    model.commit_operation
    { status: 'ok', entity_id: eid, distance: dist_mm, units: 'mm' }
  end

  def self.handle_follow_me(p)
    fid  = p['face_id']
    pids = p['path_ids']
    raise "face_id required"               unless fid
    raise "path_ids array required"         unless pids.is_a?(Array)

    face = find_entity_by_id(fid)
    raise "Face #{fid} not found"           unless face
    raise "Entity #{fid} is not a Face"     unless face.is_a?(Sketchup::Face)

    path = pids.map do |id|
      e = find_entity_by_id(id)
      raise "Edge #{id} not found"          unless e
      raise "Entity #{id} is not an Edge"   unless e.is_a?(Sketchup::Edge)
      e
    end

    model.start_operation('MCP: FollowMe', true)
    face.followme(path)
    model.commit_operation
    { status: 'ok', face_id: fid, path_edges: path.length }
  end

  # --- Transformations ---

  def self.handle_move_entity(p)
    eid = p['entity_id']
    vec = p['vector']
    raise "entity_id required"           unless eid
    raise "vector [x,y,z] required"      unless vec.is_a?(Array) && vec.length == 3

    entity = find_entity_by_id(eid)
    raise "Entity #{eid} not found"      unless entity
    raise "Entity cannot be transformed" unless entity.respond_to?(:transform!)

    # Смещение — это длина, поэтому приходит в миллиметрах.
    v = Geom::Vector3d.new(mm(vec[0]), mm(vec[1]), mm(vec[2]))
    model.start_operation('MCP: Move', true)
    entity.transform!(Geom::Transformation.translation(v))
    model.commit_operation
    { status: 'moved', entity_id: eid, vector: vec.map(&:to_f), units: 'mm' }
  end

  def self.handle_rotate_entity(p)
    eid  = p['entity_id']
    raise "entity_id required" unless eid

    entity = find_entity_by_id(eid)
    raise "Entity #{eid} not found"      unless entity
    raise "Entity cannot be transformed" unless entity.respond_to?(:transform!)

    pt  = parse_point(p['axis_point'])
    vec = Geom::Vector3d.new(*p['axis_vector'].map(&:to_f))
    ang = p['angle'].to_f

    model.start_operation('MCP: Rotate', true)
    entity.transform!(Geom::Transformation.rotation(pt, vec, ang.degrees))
    model.commit_operation
    { status: 'rotated', entity_id: eid, angle: ang }
  end

  def self.handle_scale_entity(p)
    eid = p['entity_id']
    raise "entity_id required" unless eid

    entity = find_entity_by_id(eid)
    raise "Entity #{eid} not found"      unless entity
    raise "Entity cannot be transformed" unless entity.respond_to?(:transform!)

    origin = p['origin'] ? parse_point(p['origin']) : ORIGIN
    sc = p['scale']

    t = if sc.is_a?(Array) && sc.length == 3
          Geom::Transformation.scaling(origin, sc[0].to_f, sc[1].to_f, sc[2].to_f)
        else
          s = sc.to_f
          Geom::Transformation.scaling(origin, s, s, s)
        end

    model.start_operation('MCP: Scale', true)
    entity.transform!(t)
    model.commit_operation
    { status: 'scaled', entity_id: eid }
  end

  # --- Components ---

  def self.handle_create_component(p)
    name = p['name'] || 'MCP Component'
    model.start_operation('MCP: Component', true)
    defn = model.definitions.add(name)
    defn.description = p['description'] || ''
    pt = p['origin'] ? parse_point(p['origin']) : ORIGIN
    inst = entities.add_instance(defn, Geom::Transformation.new(pt))
    model.commit_operation
    { definition: defn.name, instance_id: inst.entityID }
  end

  def self.handle_place_component(p)
    name = p['name'] || ''
    defn = model.definitions.find { |d| d.name == name }
    raise "Component '#{name}' not found" unless defn
    pt = p['origin'] ? parse_point(p['origin']) : ORIGIN
    model.start_operation('MCP: Place', true)
    inst = entities.add_instance(defn, Geom::Transformation.new(pt))
    model.commit_operation
    { instance_id: inst.entityID, definition: defn.name }
  end

  # --- Execute Ruby ---

  def self.handle_execute_ruby(p)
    code = p['code'] || ''
    raise "No code provided" if code.strip.empty?

    output = []
    old_stdout = $stdout
    $stdout = StringIO.new

    begin
      result = eval(code, TOPLEVEL_BINDING)
      output = $stdout.string.split("\n")
    ensure
      $stdout = old_stdout
    end

    { result: result.inspect, output: output }
  rescue => e
    { error: e.message, backtrace: e.backtrace.first(5) }
  end

  # --- Roof Truss (simple built-in) ---

  def self.handle_create_roof_truss(p)
    # Длины — в миллиметрах, как и везде. Уклон остаётся отношением, а
    # типоразмер пиломатериала — названием из каталога: и то и другое не длина.
    # Значения по умолчанию — привычные 610 мм между стропилами и свес 300 мм.
    span_mm     = p['span'].to_f
    pitch_str   = p['pitch'] || '6:12'
    truss_type  = p['type']  || 'fink'
    count       = (p['count'] || 1).to_i
    spacing     = mm((p['spacing']  || 610).to_f)
    overhang    = mm((p['overhang'] || 300).to_f)
    lumber_str  = p['lumber_size'] || '2x4'
    origin      = p['origin'] ? parse_point(p['origin']) : ORIGIN
    layer_name  = p['layer']

    # Parse pitch
    parts = pitch_str.split(':')
    rise_per_12 = parts[0].to_f
    span_in = mm(span_mm)
    half_span = span_in / 2.0
    peak_height = half_span * (rise_per_12 / 12.0)

    # Фактические размеры пиломатериала — дюймовые по определению стандарта.
    lumber_dims = {
      '2x4' => [1.5, 3.5],
      '2x6' => [1.5, 5.5],
      '2x8' => [1.5, 7.5]
    }
    thick, depth = lumber_dims[lumber_str] || [1.5, 3.5]

    model.start_operation("MCP: Roof Truss", true)
    truss_ids = []

    count.times do |i|
      y_offset = i * spacing
      grp = entities.add_group
      grp.name = "Truss_#{i + 1}"
      apply_layer(grp, layer_name)
      ge = grp.entities

      ox = origin.x
      oy = origin.y + y_offset
      oz = origin.z

      # Key points
      left_bottom    = [ox - overhang, oy, oz]
      left_wall      = [ox, oy, oz]
      peak           = [ox + half_span, oy, oz + peak_height]
      right_wall     = [ox + span_in, oy, oz]
      right_bottom   = [ox + span_in + overhang, oy, oz]

      # Bottom chord (full span with overhangs)
      ge.add_line(parse_point(left_bottom), parse_point(right_bottom))

      # Left rafter
      ge.add_line(parse_point(left_bottom), parse_point(peak))

      # Right rafter
      ge.add_line(parse_point(right_bottom), parse_point(peak))

      if truss_type == 'king'
        # King post: single vertical at center
        ge.add_line(parse_point([ox + half_span, oy, oz]), parse_point(peak))
      else
        # Fink / W-truss pattern
        # Vertical at center
        center_bottom = [ox + half_span, oy, oz]
        ge.add_line(parse_point(center_bottom), parse_point(peak))

        # Quarter points on bottom chord
        q1_x = ox + half_span * 0.5
        q3_x = ox + half_span * 1.5
        q1_bottom = [q1_x, oy, oz]
        q3_bottom = [q3_x, oy, oz]

        # Points on rafters at quarter spans
        q1_rafter_z = oz + (half_span * 0.5) * (rise_per_12 / 12.0) * (half_span / (half_span + overhang))
        # Simpler: interpolate along left rafter
        t_left = 0.5  # halfway along left rafter
        q1_rafter = [q1_x, oy, oz + (q1_x - (ox - overhang)) * (peak_height / (half_span + overhang))]
        q3_rafter = [q3_x, oy, oz + ((ox + span_in + overhang) - q3_x) * (peak_height / (half_span + overhang))]

        # Verticals at quarter points
        ge.add_line(parse_point(q1_bottom), parse_point(q1_rafter))
        ge.add_line(parse_point(q3_bottom), parse_point(q3_rafter))

        # Diagonal webs (W pattern)
        ge.add_line(parse_point(q1_rafter), parse_point(center_bottom))
        ge.add_line(parse_point(q3_rafter), parse_point(center_bottom))
      end

      truss_ids << grp.entityID
    end

    model.commit_operation
    {
      status:    'created',
      count:     count,
      span_ft:   span_ft,
      pitch:     pitch_str,
      type:      truss_type,
      truss_ids: truss_ids
    }
  end

  # ---------------------------------------------------------------------------
  # Route table
  # ---------------------------------------------------------------------------

  # ---------------------------------------------------------------------------
  # Булевы операции, фаски и скругления
  #
  # Алгоритмы перенесены из zinin/sketchup-mcp2 (MIT) — там они добыты опытом
  # и закреплены тестами. Ниже сохранены все объяснения «почему именно так»:
  # без них код выглядит переусложнённым, а на деле каждый шаг обходит
  # конкретную ловушку SketchUp.
  #
  # ЕДИНИЦЫ: как и весь остальной файл, эти обработчики принимают внутренние
  # единицы SketchUp (дюймы). У zinin на входе миллиметры с конвертацией; здесь
  # конвертации нет намеренно — две разные единицы в одном файле опаснее, чем
  # одна непривычная. Перевод всего плагина на миллиметры — отдельная задача.
  # ---------------------------------------------------------------------------

  BOOLEAN_OPS = %w[union difference intersection].freeze

  # Инструменты работы с телами (union/subtract/intersect) живут на Group и
  # ComponentInstance, а не на Entities.
  def self.require_solid!(entity, label)
    unless entity.is_a?(Sketchup::Group) || entity.is_a?(Sketchup::ComponentInstance)
      raise "#{label} must be a Group or ComponentInstance (got #{entity.class})"
    end
    entity
  end

  def self.fetch_solid!(p, key)
    id = p[key]
    raise "#{key} is required" if id.nil?
    entity = find_entity_by_id(id)
    raise "#{key}=#{id} not found" unless entity
    require_solid!(entity, key)
  end

  def self.describe_solid(e)
    b = e.bounds
    {
      id:     e.entityID,
      type:   e.class.name.split('::').last,
      name:   (e.respond_to?(:name) ? e.name : nil),
      bounds: {
        min:  pt_mm(b.min), max: pt_mm(b.max),
        size: [to_mm(b.width), to_mm(b.height), to_mm(b.depth)]
      },
      units: 'mm'
    }
  end

  def self.safe_abort(m)
    m.abort_operation
  rescue StandardError
    nil
  end

  # Точная копия через экземпляр определения: сохраняет внутренние контуры
  # (отверстия), материалы, вложенные объекты и развёртку — ничего этого не
  # даст ручное копирование граней. Копия создаётся СОСЕДОМ оригинала, иначе
  # последующие операции с телами не сработают для вложенных целей.
  def self.duplicate_solid(entity)
    entity.parent.entities.add_instance(entity.definition, entity.transformation)
  end

  def self.handle_boolean_operation(p)
    operation = p['operation'].to_s
    unless BOOLEAN_OPS.include?(operation)
      raise "operation must be one of #{BOOLEAN_OPS.join(', ')} (got #{operation.inspect})"
    end
    delete_originals = (p['delete_originals'] == true)

    m = model
    m.start_operation("MCP: Boolean #{operation}", true)
    begin
      target = fetch_solid!(p, 'target_id')
      tool   = fetch_solid!(p, 'tool_id')

      # Операции с телами РАЗРУШИТЕЛЬНЫ: они стирают операнды и возвращают новую
      # группу. Поэтому работаем на копиях, чтобы оригиналы пользователя выжили.
      target_copy = duplicate_solid(target)
      tool_copy   = duplicate_solid(tool)

      # ВНИМАНИЕ. Group#subtract работает ОБРАТНО ожиданию: A.subtract(B)
      # возвращает «B − A», то есть аргумент минус получатель. Чтобы получить
      # «цель минус инструмент», вызывать надо tool.subtract(target).
      # Официальная документация противоречит сама себе, поэтому направление
      # закреплено опытом, а не доками. union и intersect коммутативны —
      # порядок там роли не играет.
      result = case operation
               when 'union'        then target_copy.union(tool_copy)
               when 'difference'   then tool_copy.subtract(target_copy)
               when 'intersection' then target_copy.intersect(tool_copy)
               end

      # На немногообразной геометрии операции молча возвращают nil.
      raise "boolean #{operation} failed (likely non-manifold geometry)" if result.nil?

      if delete_originals
        target.erase! if target.valid?
        tool.erase!   if tool.valid?
      end

      description = describe_solid(result)
      m.commit_operation
      description
    rescue StandardError
      safe_abort(m)
      raise
    end
  end

  # --- Фаски и скругления ---------------------------------------------------
  #
  # Почему по одному ребру за раз, а не всё сразу: у тела, где рёбра сходятся
  # в общих углах, несколько профилей в ОДНОЙ группе-резце пересекают сами
  # себя в этих углах. Операции с телами требуют, чтобы оба операнда были
  # многообразны, поэтому самопересекающийся резец даёт nil. По одному ребру —
  # каждый резец остаётся чистой призмой.
  #
  # Почему два перпендикуляра В ПЛОСКОСТЯХ ГРАНЕЙ, а не нормаль: фаска снимает
  # материал симметрично с ОБЕИХ смежных граней, и профиль должен лежать в
  # плоскости, перпендикулярной ребру. Нормаль грани оказывается в этой
  # плоскости только если ребро уже лежит в грани — иначе профиль уезжает
  # НАРУЖУ тела и вычитать становится нечего.

  # Смещение резца, дюймы. Больше допуска SketchUp в 0.001.
  CUTTER_OFFSET = 0.005

  def self.handle_chamfer_edges(p)
    raise 'distance must be positive' unless p['distance'].to_f > 0
    distance = mm(p['distance']) # внутрь — в дюймах
    run_edge_op(p, 'MCP: Chamfer', distance * 2) do |cutter_entities, spec|
      build_chamfer_profile(cutter_entities, spec, distance)
    end
  end

  def self.handle_fillet_edges(p)
    raise 'radius must be positive' unless p['radius'].to_f > 0
    radius = mm(p['radius'])
    segments = (p['segments'] || 8).to_i
    raise 'segments must be positive' unless segments > 0
    run_edge_op(p, 'MCP: Fillet', radius * 2) do |cutter_entities, spec|
      build_fillet_profile(cutter_entities, spec, radius, segments)
    end
  end

  def self.solid_entities(entity)
    entity.is_a?(Sketchup::Group) ? entity.entities : entity.definition.entities
  end

  # Общий движок для фаски и скругления. Снимок рёбер делается ОДИН раз, но
  # перед каждым резом ребро ищется заново в текущей геометрии: после каждого
  # вычитания тело меняется, углы срезаются, середины рёбер уезжают, и строить
  # следующий резец по старому снимку значит промахнуться мимо тела.
  def self.run_edge_op(p, op_name, match_tolerance)
    edge_indices = p['edge_indices']
    if edge_indices && !edge_indices.is_a?(Array)
      raise "edge_indices must be an array of integers (got #{edge_indices.class})"
    end

    m = model
    m.start_operation(op_name, true)
    stats = { 'attempted' => 0, 'skipped_no_match' => 0,
              'subtract_failed' => 0, 'succeeded' => 0 }
    begin
      entity = fetch_solid!(p, 'entity_id')
      edges = solid_entities(entity).grep(Sketchup::Edge)
      edges = edges.select.with_index { |_, i| edge_indices.include?(i) } if edge_indices
      raise "no edges to process on entity_id=#{p['entity_id']}" if edges.empty?

      original_specs = edges.map { |e| edge_spec(e, entity.transformation) }
      stats['attempted'] = original_specs.length

      # Результат вычитания может стать «протухшим» указателем после следующих
      # разрушительных операций, а числовой идентификатор остаётся годным.
      last_result_id = nil

      original_specs.each do |orig|
        live_spec = find_current_edge_spec(entity, orig, match_tolerance)
        if live_spec.nil?
          stats['skipped_no_match'] += 1
          next # ребро съедено предыдущим резом
        end

        cutter  = entity.parent.entities.add_group
        profile = yield(cutter.entities, live_spec)
        profile.followme(reconstruct_edge(cutter.entities, live_spec))

        # Снова обратная семантика: чтобы получить «тело минус резец»,
        # вызываем cutter.subtract(entity).
        result = cutter.subtract(entity)
        if result.nil?
          stats['subtract_failed'] += 1
          cutter.erase! if cutter.valid?
          next
        end
        last_result_id = result.entityID
        entity = result
        stats['succeeded'] += 1
      end

      if stats['succeeded'] == 0
        raise "#{op_name}: no edges could be cut (geometry may be non-manifold)"
      end

      # Перечитываем по идентификатору: после цепочки вычитаний локальная
      # ссылка бывает невалидной, а describe вызываем ДО commit_operation —
      # фиксация транзакции тоже обесценивает указатели на результат.
      fresh = last_result_id ? m.find_entity_by_id(last_result_id) : nil
      raise "#{op_name}: final entity invalid (id=#{last_result_id})" if fresh.nil? || !fresh.valid?

      description = describe_solid(fresh).merge(stats: stats)
      m.commit_operation
      description
    rescue StandardError
      safe_abort(m)
      raise
    end
  end

  # Ищем в теле ребро, пришедшее на смену исходному: параллельное направление
  # плюс середина в пределах допуска. nil — исходное ребро срезано предыдущим.
  def self.find_current_edge_spec(entity, orig_spec, tolerance)
    cur_edges = solid_entities(entity).grep(Sketchup::Edge).select { |e| e.faces.length >= 2 }
    return nil if cur_edges.empty?

    orig_dir = orig_spec[:end_pos] - orig_spec[:start_pos]
    return nil if orig_dir.length < 1e-10
    orig_dir.length = 1.0
    orig_mid = midpoint_of(orig_spec[:start_pos], orig_spec[:end_pos])

    xform = entity.transformation
    best = nil
    best_dist = 1.0 / 0.0 # бесконечность
    cur_edges.each do |edge|
      cs = xform * edge.start.position
      ce = xform * edge.end.position
      cur_dir = ce - cs
      next if cur_dir.length < 1e-10
      cur_dir.length = 1.0
      next unless cur_dir.parallel?(orig_dir)

      dist = orig_mid.distance(midpoint_of(cs, ce))
      if dist < best_dist
        best_dist = dist
        best = edge
      end
    end

    return nil if best.nil? || best_dist > tolerance
    edge_spec(best, entity.transformation)
  end

  def self.midpoint_of(a, b)
    Geom::Point3d.new((a.x + b.x) / 2.0, (a.y + b.y) / 2.0, (a.z + b.z) / 2.0)
  end

  # Снимок ребра вместе с внутренними перпендикулярами ОБЕИХ смежных граней.
  # Всё проецируется через преобразование, чтобы жить в системе координат
  # родителя — там же, где будет создан резец.
  def self.edge_spec(edge, xform)
    faces = edge.faces.first(2)
    if faces.length < 2
      raise "edge ##{edge.entityID} has #{faces.length} adjacent face(s); " \
            'chamfer/fillet requires a closed dihedral (2 faces)'
    end

    edge_pt  = edge.start.position
    edge_end = edge.end.position
    edge_dir = edge_end - edge_pt
    edge_dir.length = 1.0

    {
      start_pos: xform * edge_pt,
      end_pos:   xform * edge_end,
      perp1:     xform * in_face_perp_inward(faces[0], edge_pt, edge_dir),
      perp2:     xform * in_face_perp_inward(faces[1], edge_pt, edge_dir)
    }
  end

  # Единичный вектор в плоскости грани, перпендикулярный ребру и направленный
  # внутрь грани. Знак выбираем по центру габарита грани.
  def self.in_face_perp_inward(face, edge_pt, edge_dir)
    perp = edge_dir.cross(face.normal)
    if perp.length < 1e-10
      perp = edge_dir.parallel?(Z_AXIS) ? X_AXIS.clone : Z_AXIS.clone
    end
    perp.length = 1.0
    to_interior = face.bounds.center - edge_pt
    perp = perp.reverse if perp.dot(to_interior) < 0
    perp
  end

  # Среднее перпендикуляров — смотрит внутрь снимаемого клина.
  def self.perp_avg(spec)
    v = Geom::Vector3d.new(
      spec[:perp1].x + spec[:perp2].x,
      spec[:perp1].y + spec[:perp2].y,
      spec[:perp1].z + spec[:perp2].z
    )
    v.length = 1.0 if v.length > 1e-10
    v
  end

  # Резец намеренно вылезает за тело со всех сторон. Иначе его грани совпадают
  # с гранями цели по плоскости, а на совпадающих плоскостях вычитание
  # схлопывается и возвращает пустую группу.
  def self.cutter_path_start(spec)
    dir = spec[:end_pos] - spec[:start_pos]
    dir.length = 1.0
    spec[:start_pos]
      .offset(dir.reverse, CUTTER_OFFSET)
      .offset(perp_avg(spec).reverse, CUTTER_OFFSET / 2.0)
  end

  def self.cutter_path_end(spec)
    dir = spec[:end_pos] - spec[:start_pos]
    dir.length = 1.0
    spec[:end_pos]
      .offset(dir, CUTTER_OFFSET)
      .offset(perp_avg(spec).reverse, CUTTER_OFFSET / 2.0)
  end

  def self.reconstruct_edge(ents, spec)
    ents.add_line(cutter_path_start(spec), cutter_path_end(spec))
  end

  # Профиль фаски — прямоугольный треугольник в плоскости, перпендикулярной
  # ребру. Протягивание вдоль ребра даёт треугольную призму: ровно тот клин,
  # который надо снять с двугранного угла.
  def self.build_chamfer_profile(ents, spec, distance)
    origin = cutter_path_start(spec)
    ents.add_face(
      origin,
      origin.offset(spec[:perp1], distance),
      origin.offset(spec[:perp2], distance)
    )
  end

  # Профиль скругления — четверть дуги плюс угловая точка, чтобы контур
  # замкнулся. Протягивание даёт четверть цилиндра.
  def self.build_fillet_profile(ents, spec, radius, segments)
    origin = cutter_path_start(spec)
    perp1  = spec[:perp1]
    perp2  = spec[:perp2]
    arc_center = origin.offset(perp1, radius).offset(perp2, radius)

    arc = (0..segments).map do |i|
      theta = Math::PI / 2 * i.to_f / segments
      arc_center
        .offset(perp2.reverse, radius * Math.cos(theta))
        .offset(perp1.reverse, radius * Math.sin(theta))
    end
    ents.add_face(arc + [origin])
  end

  # --- Идентификация и вид ---

  # Кто я такой и какая модель во мне открыта. По этому ответу внешняя сторона
  # убеждается, что стучится именно в то окно, к которому привязана сессия.
  def self.handle_instance_info(_p)
    instance_descriptor.merge(
      instances_dir: INSTANCES_DIR,
      running:       server_running?
    )
  end

  # Снимок вьюпорта — основа цикла «построить → отрендерить → раскритиковать».
  # Возвращаем и путь к файлу, и base64, чтобы вызывающая сторона могла как
  # передать картинку модели, так и просто забрать файл.
  def self.handle_viewport_screenshot(p)
    width  = (p['width']  || p[:width]  || 1000).to_i
    height = (p['height'] || p[:height] || 750).to_i
    inline = p.key?('inline') ? p['inline'] : true

    path = File.join(LOG_DIR, "su_shot_#{Process.pid}_#{Time.now.to_i}.png")
    view = model.active_view

    ok = begin
      # Явные фигурные скобки: в Ruby 3 именованные аргументы не превращаются
      # автоматически в хеш для методов, которые ждут именно хеш.
      view.write_image({ filename: path, width: width, height: height,
                         antialias: true, compression: 0.9, transparent: false })
    rescue ArgumentError, TypeError
      # Старые версии не принимают хеш — там позиционные аргументы.
      view.write_image(path, width, height, true, 0.9)
    end

    unless File.exist?(path)
      raise "write_image did not produce a file (returned #{ok.inspect})"
    end

    result = {
      path:   path,
      width:  width,
      height: height,
      bytes:  File.size(path)
    }
    if inline
      result[:mime]   = 'image/png'
      result[:base64] = Base64.strict_encode64(File.binread(path))
    end
    result
  end

  ROUTES = {
    ['GET',  '/instance/info']           => :handle_instance_info,
    ['POST', '/view/screenshot']         => :handle_viewport_screenshot,
    ['POST', '/operations/boolean']      => :handle_boolean_operation,
    ['POST', '/operations/chamfer']      => :handle_chamfer_edges,
    ['POST', '/operations/fillet']       => :handle_fillet_edges,
    ['GET',  '/model/info']              => :handle_get_model_info,
    ['GET',  '/model/layers']            => :handle_list_layers,
    ['GET',  '/model/materials']         => :handle_list_materials,
    ['GET',  '/model/entities']          => :handle_list_entities,
    ['GET',  '/model/components']        => :handle_list_components,
    ['POST', '/geometry/face']           => :handle_create_face,
    ['POST', '/geometry/edge']           => :handle_create_edge,
    ['POST', '/geometry/group']          => :handle_create_group,
    ['POST', '/geometry/box']            => :handle_create_box,
    ['POST', '/geometry/circle']         => :handle_create_circle,
    ['POST', '/geometry/arc']            => :handle_create_arc,
    ['POST', '/geometry/polygon']        => :handle_create_polygon,
    ['POST', '/geometry/pushpull']       => :handle_push_pull,
    ['POST', '/geometry/followme']       => :handle_follow_me,
    ['POST', '/transform/move']          => :handle_move_entity,
    ['POST', '/transform/rotate']        => :handle_rotate_entity,
    ['POST', '/transform/scale']         => :handle_scale_entity,
    ['POST', '/components/create']       => :handle_create_component,
    ['POST', '/components/place']        => :handle_place_component,
    ['POST', '/construction/roof_truss'] => :handle_create_roof_truss,
    ['POST', '/ruby/execute']            => :handle_execute_ruby,
  }.freeze

  # ---------------------------------------------------------------------------
  # HTTP handling
  # ---------------------------------------------------------------------------

  def self.build_response(data, status = 200)
    json = JSON.generate(data)
    text = { 200 => 'OK', 400 => 'Bad Request', 404 => 'Not Found',
             500 => 'Internal Server Error', 504 => 'Gateway Timeout' }[status] || 'Error'
    "HTTP/1.1 #{status} #{text}\r\n" \
    "Content-Type: application/json\r\n" \
    "Content-Length: #{json.bytesize}\r\n" \
    "Access-Control-Allow-Origin: *\r\n" \
    "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n" \
    "Access-Control-Allow-Headers: Content-Type\r\n" \
    "Connection: close\r\n" \
    "\r\n" \
    "#{json}"
  end

  def self.build_error(msg, status = 400)
    build_response({ error: msg }, status)
  end

  def self.read_http_request(client)
    # Read request line + headers
    headers_raw = ''
    while (line = client.gets)
      headers_raw += line
      break if line.strip.empty?
    end
    return nil if headers_raw.empty?

    lines = headers_raw.split("\r\n")
    request_line = lines[0] || ''
    method, full_path, _ = request_line.split(' ', 3)
    return nil unless method && full_path

    # Parse path & query
    path, query_string = full_path.split('?', 2)
    query = {}
    if query_string
      query_string.split('&').each do |pair|
        k, v = pair.split('=', 2)
        query[URI.decode_www_form_component(k)] = URI.decode_www_form_component(v || '')
      end
    end

    # Read body if Content-Length
    body = ''
    cl_header = lines.find { |l| l =~ /^content-length:\s*(\d+)/i }
    if cl_header && cl_header =~ /(\d+)/
      cl = $1.to_i
      body = client.read(cl) if cl > 0
    end

    { method: method, path: path, query: query, body: body }
  rescue => e
    log "Read error: #{e.message}"
    nil
  end

  def self.dispatch_request(req)
    method = req[:method]
    path   = req[:path]

    # Handle CORS preflight
    if method == 'OPTIONS'
      return build_response({ status: 'ok' }, 200)
    end

    handler = ROUTES[[method, path]]
    unless handler
      return build_error("Unknown route: #{method} #{path}", 404)
    end

    # Parse params
    params = {}
    if method == 'POST' && !req[:body].empty?
      begin
        params = JSON.parse(req[:body])
      rescue JSON::ParserError => e
        return build_error("Invalid JSON: #{e.message}", 400)
      end
    elsif method == 'GET'
      params = req[:query]
    end

    # Queue for main thread execution
    request_obj = {
      handler:   handler,
      params:    params,
      response:  nil,
      error:     nil,
      done:      false
    }

    @queue_mutex.synchronize { @request_queue << request_obj }

    # Wait for main thread to process (up to 120s for complex operations)
    deadline = Time.now + 120
    loop do
      break if request_obj[:done]
      if Time.now > deadline
        return build_error("Request timed out after 120s", 504)
      end
      sleep(0.05)
    end

    if request_obj[:error]
      build_error(request_obj[:error], 500)
    else
      build_response(request_obj[:response])
    end
  end

  # ---------------------------------------------------------------------------
  # Main thread queue processor (called by UI.start_timer)
  # ---------------------------------------------------------------------------

  def self.process_queue
    # Освежаем визитку примерно раз в 2 секунды (таймер тикает каждые 0.05):
    # пользователь мог сохранить модель под другим именем или открыть другую,
    # и внешняя сторона должна видеть это без перезапуска.
    @ticks += 1
    if @ticks % 40 == 0
      write_card if @server
    end
    # Уборка чужих визиток — не только при старте. Замерено: окно, закрытое
    # уже ПОСЛЕ нашего старта, оставляло визитку навсегда, потому что подмести
    # её было некому. Раз в 30 секунд достаточно и почти ничего не стоит.
    if @ticks >= 600
      @ticks = 0
      sweep_stale_cards if @server
    end

    req = nil
    @queue_mutex.synchronize do
      return if @request_queue.empty?
      req = @request_queue.shift
    end
    return unless req

    begin
      result = send(req[:handler], req[:params])
      req[:response] = result
    rescue => e
      log "Handler error: #{e.class}: #{e.message}"
      log e.backtrace.first(3).join("\n") if e.backtrace
      req[:error] = "#{e.class}: #{e.message}"
    ensure
      req[:done] = true
    end
  rescue => e
    log "CRITICAL process_queue error: #{e.message}"
  end

  # ---------------------------------------------------------------------------
  # Server lifecycle
  # ---------------------------------------------------------------------------

  # Пробуем предпочитаемый порт, чтобы первое окно вело себя как раньше и
  # старые клиенты продолжали работать. Занят — просим у системы любой
  # свободный (порт 0). Перебирать диапазон вручную не нужно.
  def self.bind_socket
    begin
      socket = TCPServer.new('127.0.0.1', PREFERRED_PORT)
      log "Bound preferred port #{PREFERRED_PORT}"
      return socket
    rescue Errno::EADDRINUSE
      log "Port #{PREFERRED_PORT} busy (другое окно SketchUp) — беру свободный"
    end

    socket = TCPServer.new('127.0.0.1', 0)
    log "Bound OS-assigned port #{socket.addr[1]}"
    socket
  end

  def self.start_server
    if @server
      log "Server already running on port #{@port}"
      return
    end

    begin
      @server  = bind_socket
      @port    = @server.addr[1]
      @running = true

      sweep_stale_cards
      write_card

      # Accept connections in a background thread
      @thread = Thread.new do
        while @running
          begin
            break unless @server && !@server.closed?
            client = @server.accept_nonblock
            Thread.new(client) do |c|
              begin
                req = read_http_request(c)
                if req
                  resp = dispatch_request(req)
                  c.write(resp)
                end
              rescue => e
                log "Client error: #{e.message}"
              ensure
                c.close rescue nil
              end
            end
          rescue IO::WaitReadable, Errno::EINTR
            break unless @server && !@server.closed?
            IO.select([@server], nil, nil, 0.2) rescue nil
          rescue IOError
            # Socket was closed (server stopping) — exit cleanly
            break
          rescue => e
            break unless @running
            log "Accept error: #{e.message}"
            sleep 0.1
          end
        end
      end

      # Timer to process queued requests on the main SketchUp UI thread
      @timer_id = UI.start_timer(0.05, true) { SU_MCP.process_queue }

      log "Server started on http://127.0.0.1:#{@port}"
      log "Instance #{@instance_id} pid #{Process.pid}"
      log "Log file: #{LOG_FILE}"

    rescue => e
      # Модальных окон здесь быть не должно: диалог останавливает главный поток,
      # а на нём работает обработчик очереди — мост немел бы целиком.
      # Состояние смотрим через меню Plugins → MCP Server → Server Status.
      log "ERROR: Failed to start: #{e.class} - #{e.message}"
      @server = nil
      @port   = nil
    end
  end

  def self.stop_server
    return unless @server
    @running = false
    UI.stop_timer(@timer_id) if @timer_id
    @timer_id = nil
    @server.close rescue nil
    @thread&.join(2)
    @server = nil
    @thread = nil
    @port   = nil
    remove_card
    log "Server stopped"
  end

  def self.restart_server
    stop_server
    sleep 0.5
    start_server
  end

  def self.server_running?
    !@server.nil? && @running
  end

  # ---------------------------------------------------------------------------
  # SketchUp menu registration & auto-start
  # ---------------------------------------------------------------------------

  # Визитку надо убрать и при обычном закрытии SketchUp: stop_server вызывается
  # только из меню, а при выходе из приложения процесс просто исчезает.
  class AppWatcher < Sketchup::AppObserver
    def onQuit
      SU_MCP.remove_card
    end
  end

  unless file_loaded?(__FILE__)
    log "Loading SketchUp MCP Plugin v2.3"
    Sketchup.add_observer(AppWatcher.new) rescue nil
    at_exit { SU_MCP.remove_card rescue nil }
    log "Ruby #{RUBY_VERSION} | SketchUp #{Sketchup.version}"

    menu = UI.menu('Plugins').add_submenu('MCP Server')

    # Главный пункт — первым: им пользуются каждый день, остальными почти никогда.
    # Галочка показывает состояние, поэтому отдельного «где я работаю» не нужно.
    target_item = menu.add_item('Окно для ИИ / Window for AI') { SU_MCP.toggle_ai_target }
    menu.set_validation_proc(target_item) { SU_MCP.ai_target? ? MF_CHECKED : MF_UNCHECKED }

    menu.add_separator
    menu.add_item('Start Server')   { SU_MCP.start_server }
    menu.add_item('Stop Server')    { SU_MCP.stop_server }
    menu.add_item('Restart Server') { SU_MCP.restart_server }
    menu.add_item('Server Status')  {
      if SU_MCP.server_running?
        d = SU_MCP.instance_descriptor
        UI.messagebox(
          "MCP Server RUNNING\n" \
          "порт: #{d[:port]}   pid: #{d[:pid]}\n" \
          "модель: #{d[:model_title]}\n" \
          "экземпляр: #{d[:instance_id]}\n" \
          "окно для ИИ: #{SU_MCP.ai_target? ? 'да' : 'нет'}"
        )
      else
        UI.messagebox("MCP Server is STOPPED")
      end
    }

    # Auto-start
    SU_MCP.start_server

    file_loaded(__FILE__)
    log "Plugin loaded OK"
  end
end
