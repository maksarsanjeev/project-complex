# sketchup_mcp_server.rb
# SketchUp MCP Bridge Plugin - v2.1
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

  def self.parse_point(arr)
    Geom::Point3d.new(arr[0].to_f, arr[1].to_f, arr[2].to_f)
  end

  def self.parse_points(arr)
    arr.map { |p| parse_point(p) }
  end

  def self.vec3(v)
    [v.x.to_f, v.y.to_f, v.z.to_f]
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

  def self.instance_descriptor
    {
      instance_id: @instance_id,
      pid:         Process.pid,
      port:        @port,
      host:        '127.0.0.1',
      app:         'sketchup',
      app_version: (Sketchup.version.to_s rescue nil),
      plugin:      '2.1'
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

  # Процесс мог упасть, не убрав за собой. Сигнал 0 ничего не посылает —
  # это стандартная проверка «жив ли процесс».
  def self.process_alive?(pid)
    Process.kill(0, pid.to_i)
    true
  rescue Errno::ESRCH
    false
  rescue Errno::EPERM
    true # существует, но чужой
  rescue StandardError
    true # не смогли проверить — не трогаем
  end

  def self.sweep_stale_cards
    return unless File.directory?(INSTANCES_DIR)
    Dir.glob(File.join(INSTANCES_DIR, 'sketchup-*.json')).each do |path|
      pid = File.basename(path)[/sketchup-(\d+)\.json/, 1]
      next unless pid
      next if pid.to_i == Process.pid
      next if process_alive?(pid)
      File.delete(path) rescue nil
      log "Swept stale card of pid #{pid}"
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
        base[:area]   = e.area.round(4)
        base[:layer]  = e.layer.name
        base[:normal] = vec3(e.normal)
      when Sketchup::Edge
        base[:length] = e.length.round(4)
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
    { id: face.entityID, type: 'Face', area: face.area.round(4), normal: vec3(face.normal) }
  end

  def self.handle_create_edge(p)
    s = parse_point(p['start'])
    e = parse_point(p['end'])
    model.start_operation('MCP: Edge', true)
    edge = entities.add_line(s, e)
    apply_layer(edge, p['layer'])
    model.commit_operation
    { id: edge.entityID, type: 'Edge', length: edge.length.round(4) }
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
    w = p['width'].to_f
    d = p['depth'].to_f
    h = p['height'].to_f
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
    grp.name = p['name'] || "Box_#{w}x#{d}x#{h}"
    model.commit_operation
    { id: grp.entityID, name: grp.name, width: w, depth: d, height: h }
  end

  def self.handle_create_circle(p)
    center   = p['center']   ? parse_point(p['center'])   : ORIGIN
    normal   = p['normal']   ? Geom::Vector3d.new(*p['normal'].map(&:to_f)) : Z_AXIS
    radius   = p['radius'].to_f
    segments = (p['segments'] || 24).to_i
    raise "Radius must be positive" if radius <= 0
    raise "Segments must be >= 3"   if segments < 3

    model.start_operation('MCP: Circle', true)
    edges = entities.add_circle(center, normal, radius, segments)
    if p['layer']
      edges.each { |e| apply_layer(e, p['layer']) }
    end
    model.commit_operation
    { edge_count: edges.length, center: vec3(center), radius: radius, segments: segments }
  end

  def self.handle_create_arc(p)
    center     = p['center'] ? parse_point(p['center']) : ORIGIN
    xaxis      = p['xaxis']  ? Geom::Vector3d.new(*p['xaxis'].map(&:to_f))  : X_AXIS
    normal     = p['normal'] ? Geom::Vector3d.new(*p['normal'].map(&:to_f)) : Z_AXIS
    radius     = p['radius'].to_f
    start_a    = (p['start_angle'] || 0).to_f
    end_a      = (p['end_angle']   || 180).to_f
    segments   = (p['segments']    || 12).to_i
    raise "Radius must be positive" if radius <= 0

    model.start_operation('MCP: Arc', true)
    edges = entities.add_arc(center, xaxis, normal, radius, start_a.degrees, end_a.degrees, segments)
    if p['layer']
      edges.each { |e| apply_layer(e, p['layer']) }
    end
    model.commit_operation
    { edge_count: edges.length, center: vec3(center), radius: radius }
  end

  def self.handle_create_polygon(p)
    center    = p['center'] ? parse_point(p['center']) : ORIGIN
    normal    = p['normal'] ? Geom::Vector3d.new(*p['normal'].map(&:to_f)) : Z_AXIS
    radius    = p['radius'].to_f
    num_sides = p['num_sides'].to_i
    inscribed = p['inscribed'].nil? ? true : p['inscribed']
    raise "Radius must be positive"     if radius <= 0
    raise "Need at least 3 sides"       if num_sides < 3

    model.start_operation('MCP: Polygon', true)
    edges = entities.add_ngon(center, normal, radius, num_sides, inscribed)
    # Also create the face
    pts = edges.map { |e| e.start.position }
    face = entities.add_face(pts) rescue nil
    apply_layer(face, p['layer']) if face && p['layer']
    apply_material(face, p['material']) if face && p['material']
    model.commit_operation
    {
      edge_count: edges.length,
      face_id:    face ? face.entityID : nil,
      center:     vec3(center),
      radius:     radius,
      num_sides:  num_sides
    }
  end

  def self.handle_push_pull(p)
    eid  = p['entity_id']
    dist = p['distance'].to_f
    raise "entity_id required" unless eid

    face = find_entity_by_id(eid)
    raise "Entity #{eid} not found"        unless face
    raise "Entity #{eid} is not a Face"    unless face.is_a?(Sketchup::Face)

    model.start_operation('MCP: PushPull', true)
    face.pushpull(dist)
    model.commit_operation
    { status: 'ok', entity_id: eid, distance: dist }
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

    v = Geom::Vector3d.new(vec[0].to_f, vec[1].to_f, vec[2].to_f)
    model.start_operation('MCP: Move', true)
    entity.transform!(Geom::Transformation.translation(v))
    model.commit_operation
    { status: 'moved', entity_id: eid, vector: vec3(v) }
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
    span_ft     = p['span'].to_f
    pitch_str   = p['pitch'] || '6:12'
    truss_type  = p['type']  || 'fink'
    count       = (p['count'] || 1).to_i
    spacing     = (p['spacing'] || 24).to_f
    overhang    = (p['overhang'] || 12).to_f
    lumber_str  = p['lumber_size'] || '2x4'
    origin      = p['origin'] ? parse_point(p['origin']) : ORIGIN
    layer_name  = p['layer']

    # Parse pitch
    parts = pitch_str.split(':')
    rise_per_12 = parts[0].to_f
    span_in = span_ft * 12.0
    half_span = span_in / 2.0
    peak_height = half_span * (rise_per_12 / 12.0)

    # Lumber actual dimensions
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
    if @ticks >= 40
      @ticks = 0
      write_card if @server
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

  unless file_loaded?(__FILE__)
    log "Loading SketchUp MCP Plugin v2.0"
    log "Ruby #{RUBY_VERSION} | SketchUp #{Sketchup.version}"

    menu = UI.menu('Plugins').add_submenu('MCP Server')
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
          "экземпляр: #{d[:instance_id]}"
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
