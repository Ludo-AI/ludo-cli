# Loads every SpriteFrames .tres listed in res://out/cases.json (written by
# generate.mjs) and checks it against the expected layout. Exits 1 on any
# mismatch. Run via run.sh, which also fails on any Godot ERROR/WARNING output.
extends SceneTree

var failures := 0


func fail(case_name: String, msg: String) -> void:
	failures += 1
	printerr("FAIL [%s] %s" % [case_name, msg])


func _initialize() -> void:
	var text := FileAccess.get_file_as_string("res://out/cases.json")
	var cases = JSON.parse_string(text)
	if typeof(cases) != TYPE_ARRAY or cases.is_empty():
		printerr("FAIL could not read res://out/cases.json")
		quit(1)
		return
	for c in cases:
		check_case(c)
	var tilesets = JSON.parse_string(FileAccess.get_file_as_string("res://out/tilesets.json"))
	if typeof(tilesets) != TYPE_ARRAY or tilesets.is_empty():
		fail("tilesets", "could not read res://out/tilesets.json")
	else:
		for t in tilesets:
			check_tileset(t)
	var sounds = JSON.parse_string(FileAccess.get_file_as_string("res://out/sounds.json"))
	if typeof(sounds) != TYPE_ARRAY or sounds.is_empty():
		fail("sounds", "could not read res://out/sounds.json")
		sounds = []
	for s in sounds:
		check_sound(s)
	if failures == 0:
		print("ALL %d CASES PASSED" % (cases.size() + tilesets.size() + sounds.size()))
	quit(1 if failures > 0 else 0)


func check_case(c: Dictionary) -> void:
	var name: String = c.name
	var failures_before := failures
	var res = ResourceLoader.load(c.tres, "", ResourceLoader.CACHE_MODE_IGNORE)
	if res == null:
		fail(name, "could not load %s" % c.tres)
		return
	if not (res is SpriteFrames):
		fail(name, "%s is %s, not SpriteFrames" % [c.tres, res.get_class()])
		return
	var sf: SpriteFrames = res
	var anim := StringName(c.animation)
	if not sf.has_animation(anim):
		fail(name, "missing animation %s (have %s)" % [anim, sf.get_animation_names()])
		return
	if sf.get_animation_names().size() != 1:
		fail(name, "expected exactly 1 animation, got %s" % [sf.get_animation_names()])
	var expected_frames: Array = c.frames
	if sf.get_frame_count(anim) != expected_frames.size():
		fail(name, "frame count %d != %d" % [sf.get_frame_count(anim), expected_frames.size()])
		return
	if not is_equal_approx(sf.get_animation_speed(anim), float(c.fps)):
		fail(name, "speed %s != %s" % [sf.get_animation_speed(anim), c.fps])
	if bool(sf.get_animation_loop(anim)) != bool(c.loop):
		fail(name, "loop %s != %s" % [sf.get_animation_loop(anim), c.loop])

	var sheet_image: Image = null
	for i in expected_frames.size():
		var f: Dictionary = expected_frames[i]
		var tex = sf.get_frame_texture(anim, i)
		if not (tex is AtlasTexture):
			fail(name, "frame %d texture is not an AtlasTexture" % i)
			continue
		var at: AtlasTexture = tex
		var r: Array = f.region
		var want := Rect2(r[0], r[1], r[2], r[3])
		if at.region != want:
			fail(name, "frame %d region %s != %s" % [i, at.region, want])
		var m: Array = f.get("margin", [0, 0, 0, 0])
		var want_margin := Rect2(m[0], m[1], m[2], m[3])
		if at.margin != want_margin:
			fail(name, "frame %d margin %s != %s" % [i, at.margin, want_margin])
		if f.has("margin") and at.get_size() != Vector2(m[2] + r[2], m[3] + r[3]):
			fail(name, "frame %d size %s is not the untrimmed size" % [i, at.get_size()])
		if not is_equal_approx(sf.get_frame_duration(anim, i), 1.0):
			fail(name, "frame %d duration %s != 1.0" % [i, sf.get_frame_duration(anim, i)])
		if at.atlas == null:
			fail(name, "frame %d atlas is null" % i)
			continue
		if at.atlas.resource_path != c.sheet:
			fail(name, "frame %d atlas path %s != %s" % [i, at.atlas.resource_path, c.sheet])
		if sheet_image == null:
			sheet_image = at.atlas.get_image()
			if sheet_image.is_compressed():
				sheet_image.decompress()
		# Sample the center and the corners of the region: each frame is a
		# solid distinct color, so any off-by-a-cell region shows up here.
		var want_color := Color(f.color[0], f.color[1], f.color[2], f.color[3])
		var points := [
			at.region.position + at.region.size / 2,
			at.region.position,
			at.region.position + at.region.size - Vector2.ONE,
		]
		for p in points:
			var got := sheet_image.get_pixelv(Vector2i(p))
			if _far(got, want_color):
				fail(name, "frame %d pixel %s color %s != %s" % [i, p, got, want_color])
				break
	if failures == failures_before:
		print("ok [%s] %d frames, %s @ %s fps, loop=%s" % [name, expected_frames.size(), anim, c.fps, c.loop])


func _far(a: Color, b: Color) -> bool:
	var tol := 2.0 / 255.0
	return absf(a.r - b.r) > tol or absf(a.g - b.g) > tol or absf(a.b - b.b) > tol or absf(a.a - b.a) > tol


# A TileSet from src/toolbox/tiles.ts: one atlas source with the tiles listed,
# each region where it should be, showing its tile's colour.
func check_tileset(t: Dictionary) -> void:
	var name: String = "tileset " + t.name
	var failures_before := failures
	var res = ResourceLoader.load(t.tres, "", ResourceLoader.CACHE_MODE_IGNORE)
	if not (res is TileSet):
		fail(name, "%s did not load as a TileSet" % t.tres)
		return
	var ts: TileSet = res
	if ts.tile_size != Vector2i(t.tile[0], t.tile[1]):
		fail(name, "tile_size %s" % ts.tile_size)
	if ts.get_source_count() != 1:
		fail(name, "%d sources" % ts.get_source_count())
		return
	var src = ts.get_source(ts.get_source_id(0))
	if not (src is TileSetAtlasSource):
		fail(name, "source is not a TileSetAtlasSource")
		return
	var atlas: TileSetAtlasSource = src
	if atlas.texture_region_size != Vector2i(t.tile[0], t.tile[1]):
		fail(name, "texture_region_size %s" % atlas.texture_region_size)
	if atlas.separation != Vector2i(t.spacing, t.spacing):
		fail(name, "separation %s" % atlas.separation)
	if atlas.margins != Vector2i(t.margin, t.margin):
		fail(name, "margins %s" % atlas.margins)
	var want: Array = t.tiles
	if atlas.get_tiles_count() != want.size():
		fail(name, "%d tiles, want %d" % [atlas.get_tiles_count(), want.size()])
	var image := atlas.texture.get_image()
	if image.is_compressed():
		image.decompress()
	for w in want:
		var coords := Vector2i(w.coords[0], w.coords[1])
		if not atlas.has_tile(coords):
			fail(name, "no tile at %s" % coords)
			continue
		var region := atlas.get_tile_texture_region(coords)
		if region != Rect2i(w.region[0], w.region[1], w.region[2], w.region[3]):
			fail(name, "tile %s region %s" % [coords, region])
			continue
		var got := image.get_pixelv(region.position + region.size / 2)
		if _far(got, Color(w.color[0], w.color[1], w.color[2], w.color[3])):
			fail(name, "tile %s colour %s" % [coords, got])
	if failures == failures_before:
		print("ok [%s] %d tiles" % [name, want.size()])


# A WAV from src/toolbox/wav.ts: its rate, channels and length, and the smpl
# loop as a forward loop over the whole sound. The smpl end is the last
# sample played (inclusive), which Godot keeps as its loop_end: samples - 1.
func check_sound(s: Dictionary) -> void:
	var name: String = s.name
	var res = ResourceLoader.load(s.path, "", ResourceLoader.CACHE_MODE_IGNORE)
	if not (res is AudioStreamWAV):
		fail(name, "%s did not import as an AudioStreamWAV" % s.path)
		return
	var w: AudioStreamWAV = res
	if w.mix_rate != int(s.rate):
		fail(name, "mix rate %d != %d" % [w.mix_rate, s.rate])
	if w.stereo != bool(s.stereo):
		fail(name, "stereo %s != %s" % [w.stereo, s.stereo])
	var length := float(s.samples) / float(s.rate)
	if absf(w.get_length() - length) > 0.002:
		fail(name, "length %s != %s" % [w.get_length(), length])
	if bool(s.loop):
		if w.loop_mode != AudioStreamWAV.LOOP_FORWARD:
			fail(name, "loop mode %d is not forward" % w.loop_mode)
		if w.loop_begin != 0:
			fail(name, "loop begin %d != 0" % w.loop_begin)
		if w.loop_end != int(s.samples) - 1:
			fail(name, "loop end %d is not the last sample (%d)" % [w.loop_end, int(s.samples) - 1])
		print("[%s] loop %d-%d of %d samples" % [name, w.loop_begin, w.loop_end, s.samples])
	elif w.loop_mode != AudioStreamWAV.LOOP_DISABLED:
		fail(name, "loop mode %d on a sound with no loop" % w.loop_mode)
