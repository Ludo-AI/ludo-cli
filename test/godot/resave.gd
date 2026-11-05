# Saves the resources out/resave.json lists back through Godot's own
# ResourceSaver, as the editor does when one is edited (uids, its own ids),
# for generate.mjs --rewire to light in place. Run by run.sh with --editor,
# which is what gives the saved files their uids.
extends SceneTree


func _initialize() -> void:
	var pairs = JSON.parse_string(FileAccess.get_file_as_string("res://out/resave.json"))
	var failed := false
	for p in pairs:
		var res = ResourceLoader.load(p.from, "", ResourceLoader.CACHE_MODE_IGNORE)
		var err := ResourceSaver.save(res, p.to) if res != null else ERR_CANT_OPEN
		print("RESAVED %s -> %s: %s" % [p.from, p.to, error_string(err)])
		failed = failed or err != OK
	quit(1 if failed else 0)
