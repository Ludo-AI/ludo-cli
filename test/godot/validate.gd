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
	var scenes = JSON.parse_string(FileAccess.get_file_as_string("res://out/scenes.json"))
	if typeof(scenes) != TYPE_ARRAY or scenes.is_empty():
		fail("scenes", "could not read res://out/scenes.json")
		scenes = []
	for s in scenes:
		check_scene(s)
	var stills = JSON.parse_string(FileAccess.get_file_as_string("res://out/stills.json"))
	if typeof(stills) != TYPE_ARRAY or stills.is_empty():
		fail("stills", "could not read res://out/stills.json")
		stills = []
	for s in stills:
		check_still(s)
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
		print("ALL %d CASES PASSED" % (cases.size() + scenes.size() + stills.size() + tilesets.size() + sounds.size()))
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
	var normal_image: Image = null
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
		# With a normal map the frames are cut from a CanvasTexture of the
		# sheet (diffuse) and the map, which 2D lights read normals from.
		var sheet_tex: Texture2D = at.atlas
		if c.has("normal_map"):
			if not (at.atlas is CanvasTexture):
				fail(name, "frame %d atlas is %s, not a CanvasTexture" % [i, at.atlas.get_class()])
				continue
			var canvas: CanvasTexture = at.atlas
			sheet_tex = canvas.diffuse_texture
			if canvas.normal_texture == null or canvas.normal_texture.resource_path != c.normal_map:
				fail(name, "frame %d normal texture %s != %s" % [i, canvas.normal_texture, c.normal_map])
				continue
			if canvas.get_size() != sheet_tex.get_size():
				fail(name, "CanvasTexture size %s != the sheet's %s" % [canvas.get_size(), sheet_tex.get_size()])
			if normal_image == null:
				normal_image = canvas.normal_texture.get_image()
				if normal_image.is_compressed():
					normal_image.decompress()
			var want_normal := Color(f.normal[0], f.normal[1], f.normal[2], f.normal[3])
			var got_normal := normal_image.get_pixelv(Vector2i(at.region.position + at.region.size / 2))
			if _far(got_normal, want_normal):
				fail(name, "frame %d normal %s != %s" % [i, got_normal, want_normal])
		if sheet_tex == null or sheet_tex.resource_path != c.sheet:
			fail(name, "frame %d sheet path %s != %s" % [i, sheet_tex.resource_path if sheet_tex else null, c.sheet])
			continue
		if sheet_image == null:
			sheet_image = sheet_tex.get_image()
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


# A scene from writeGodotScene: an AnimatedSprite2D on the .tres, centered,
# whose offset puts the frame's pivot at the node's origin: the frame is
# drawn from offset - size / 2, so that corner must be minus the pivot.
func check_scene(s: Dictionary) -> void:
	var name: String = s.name
	var packed = ResourceLoader.load(s.tscn, "", ResourceLoader.CACHE_MODE_IGNORE)
	if not (packed is PackedScene):
		fail(name, "%s did not load as a PackedScene" % s.tscn)
		return
	var node = packed.instantiate()
	if not (node is AnimatedSprite2D):
		fail(name, "the scene's root is %s, not AnimatedSprite2D" % node.get_class())
		node.free()
		return
	var sprite: AnimatedSprite2D = node
	var anim := StringName(s.animation)
	if sprite.sprite_frames == null or sprite.sprite_frames.get_frame_count(anim) != int(s.frames):
		fail(name, "sprite_frames missing or without %d frames of %s" % [s.frames, anim])
	elif sprite.animation != anim or sprite.autoplay != String(anim) or not sprite.centered:
		fail(name, "animation %s, autoplay %s, centered %s" % [sprite.animation, sprite.autoplay, sprite.centered])
	else:
		var tex := sprite.sprite_frames.get_frame_texture(anim, 0)
		var size := tex.get_size()
		var corner := sprite.offset - size / 2
		if corner != -Vector2(s.pivot[0], s.pivot[1]):
			fail(name, "frame drawn from %s, not minus the pivot %s" % [corner, s.pivot])
		elif s.has("normal_map") and not (tex is AtlasTexture and tex.atlas is CanvasTexture and tex.atlas.normal_texture != null and tex.atlas.normal_texture.resource_path == s.normal_map):
			fail(name, "the scene's frames are not on a CanvasTexture with %s" % s.normal_map)
		else:
			print("ok [%s] pivot %s at the node's origin%s" % [name, s.pivot, ", lit" if s.has("normal_map") else ""])
	sprite.free()


# A still image's CanvasTexture: the art and its map, both at their paths,
# imported as they are (the map lossless, no mipmaps, green as it is).
func check_still(s: Dictionary) -> void:
	var name: String = s.name
	var res = ResourceLoader.load(s.tres, "", ResourceLoader.CACHE_MODE_IGNORE)
	if not (res is CanvasTexture):
		fail(name, "%s did not load as a CanvasTexture" % s.tres)
		return
	var canvas: CanvasTexture = res
	if canvas.diffuse_texture == null or canvas.diffuse_texture.resource_path != s.diffuse:
		fail(name, "diffuse %s != %s" % [canvas.diffuse_texture, s.diffuse])
		return
	if canvas.normal_texture == null or canvas.normal_texture.resource_path != s.normal_map:
		fail(name, "normal %s != %s" % [canvas.normal_texture, s.normal_map])
		return
	if canvas.get_size() != Vector2(s.size[0], s.size[1]):
		fail(name, "size %s != %s" % [canvas.get_size(), s.size])
	var art := canvas.diffuse_texture.get_image()
	var map := canvas.normal_texture.get_image()
	if map.is_compressed() or map.has_mipmaps():
		fail(name, "the normal map imported compressed or with mipmaps")
		return
	var centre := Vector2i(s.size[0] / 2, s.size[1] / 2)
	if _far(art.get_pixelv(centre), Color(s.color[0], s.color[1], s.color[2], s.color[3])):
		fail(name, "art colour %s" % art.get_pixelv(centre))
	elif _far(map.get_pixelv(centre), Color(s.normal[0], s.normal[1], s.normal[2], s.normal[3])):
		fail(name, "normal %s" % map.get_pixelv(centre))
	else:
		var import := ConfigFile.new()
		import.load(s.normal_map + ".import")
		if import.get_value("params", "process/normal_map_invert_y", true) != false or import.get_value("params", "compress/mode", -1) != 0:
			fail(name, "the map's import settings changed it: %s" % import.encode_to_text())
		else:
			print("ok [%s] %s with %s" % [name, s.diffuse, s.normal_map])


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
	# A lit TileSet's atlas texture is a CanvasTexture of the tiles and their map.
	var tex: Texture2D = atlas.texture
	var normal_image: Image = null
	if t.has("normal_map"):
		if not (tex is CanvasTexture) or tex.normal_texture == null or tex.normal_texture.resource_path != t.normal_map:
			fail(name, "atlas texture %s is not a CanvasTexture with %s" % [tex, t.normal_map])
			return
		normal_image = tex.normal_texture.get_image()
		tex = tex.diffuse_texture
	var image := tex.get_image()
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
		elif normal_image != null and _far(normal_image.get_pixelv(region.position + region.size / 2), Color(w.normal[0], w.normal[1], w.normal[2], w.normal[3])):
			fail(name, "tile %s normal %s" % [coords, normal_image.get_pixelv(region.position + region.size / 2)])
	if failures == failures_before:
		print("ok [%s] %d tiles%s" % [name, want.size(), ", lit" if t.has("normal_map") else ""])


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
